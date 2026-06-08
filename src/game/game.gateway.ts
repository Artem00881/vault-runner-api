import { Inject, Logger, OnModuleDestroy } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { GameEngineService } from "./game-engine.service";
import { BetsService, type Panel } from "./bets.service";
import { GameSessionService } from "../operator/game-session.service";
import { deserializeBetLimits } from "../operator/bet-limits";
import { deserializeRg, type EffectiveRg } from "../operator/rg-config";
import type { PerBetLimits } from "./risk.service";
import { placeSchema, panelSchema, timeSyncSchema } from "./ws-schemas";
import { MetricsService } from "../metrics/metrics.service";
import { ElectionService } from "../ha/election.service";
import { WalletRollbackService } from "../wallet/wallet-rollback.service";
import { OPERATOR_WALLET_API } from "../wallet/wallet-provider";
import type { OperatorWalletApi } from "../wallet/operator-wallet.types";

function userRoom(userId: string) {
  return `user:${userId}`;
}

/** Per-socket responsible-gambling state the RG sweep reads (Phase 3). */
export interface RgSocketState {
  rg: EffectiveRg;
  sessionStartedAt: number; // epoch ms
  rgRealityDueAt?: number; // epoch ms of the next reality check (undefined = none configured)
  rgPending: boolean; // a reality check is awaiting ack (hard-pause mode)
  rgTimeLimitNotified: boolean; // the session_time_limit event was already emitted (emit once)
}

/** Pure RG decision for one socket at `now` — what to emit + the next per-socket state.
 *  Pure (no I/O) so it's unit-testable without constructing the gateway (which the test
 *  suite never does). The sweep performs the emits/DB read; this only decides timing. */
export interface RgDecision {
  emitRealityCheck: boolean;
  tripTimeLimit: boolean; // session time limit just crossed (emit once)
  nextDueAt?: number;
  nextPending: boolean;
  nextTimeLimitNotified: boolean;
}

export function rgEvaluate(s: RgSocketState, now: number): RgDecision {
  const base: RgDecision = {
    emitRealityCheck: false,
    tripTimeLimit: false,
    nextDueAt: s.rgRealityDueAt,
    nextPending: s.rgPending,
    nextTimeLimitNotified: s.rgTimeLimitNotified,
  };
  // Session time limit takes precedence: once reached the session is over (placeBet
  // blocks new bets) — emit it ONCE and stop reality-check reminders.
  if (s.rg.maxSessionSec !== undefined && now >= s.sessionStartedAt + s.rg.maxSessionSec * 1000) {
    return { ...base, tripTimeLimit: !s.rgTimeLimitNotified, nextTimeLimitNotified: true };
  }
  // Reality check due? Advance the timer from NOW (so a missed sweep can't burst-fire),
  // and set pending in enforce (hard-pause) mode so new bets block until ack.
  if (
    s.rg.realityCheckIntervalSec !== undefined &&
    s.rgRealityDueAt !== undefined &&
    now >= s.rgRealityDueAt
  ) {
    return {
      ...base,
      emitRealityCheck: true,
      nextDueAt: now + s.rg.realityCheckIntervalSec * 1000,
      nextPending: s.rg.enforceRealityCheck ? true : s.rgPending,
    };
  }
  return base;
}

/**
 * Resolve the 'reserving' sweep age threshold (ms) from `RESERVING_STALE_SEC`.
 * The gate is a money-safety control — a non-numeric, non-positive, or dangerously
 * low value must NEVER shrink/disable it (that could refund a placeBet still in
 * flight). Require a finite value floored at 30s (well above the worst-case
 * reserve→debit→activate window); anything else (unset/invalid/too-low) → 120s.
 */
export function resolveReservingStaleMs(raw: string | undefined): number {
  const sec = Number(raw);
  return (Number.isFinite(sec) && sec >= 30 ? sec : 120) * 1000;
}

/**
 * Real-time gateway: streams the authoritative round to clients and accepts
 * money-moving actions (bet / cash-out), all validated server-side.
 */
const WS_MSG_LIMIT = 15; // messages per second per socket

// Mirror the HTTP CORS policy (main.ts): "*"/empty → reflect any origin, else a
// comma-separated allowlist. Don't hardcode "*" (audit M2).
const rawWsCors = process.env.CORS_ORIGIN?.trim();
const WS_CORS_ORIGIN: boolean | string[] =
  !rawWsCors || rawWsCors === "*" ? true : rawWsCors.split(",").map((s) => s.trim());

@WebSocketGateway({ cors: { origin: WS_CORS_ORIGIN, credentials: true } })
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger(GameGateway.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private reconciling = false; // guards against overlapping reconcile cycles (H2)
  private reservingSweepInterval: ReturnType<typeof setInterval> | null = null;
  private sweeping = false; // guards against overlapping 'reserving' sweeps
  private rgSweepInterval: ReturnType<typeof setInterval> | null = null;
  private rgSweeping = false; // guards against overlapping RG sweeps
  private userSockets = new Map<string, string>(); // userId → socketId (one per user)
  private msgRate = new Map<string, { n: number; t: number }>();

  /** Simple per-socket token bucket; returns false when the socket is spamming. */
  private allow(client: Socket): boolean {
    const now = Date.now();
    const r = this.msgRate.get(client.id);
    if (!r || now - r.t > 1000) {
      this.msgRate.set(client.id, { n: 1, t: now });
      return true;
    }
    r.n++;
    return r.n <= WS_MSG_LIMIT;
  }

  constructor(
    @Inject(GameEngineService) private readonly engine: GameEngineService,
    @Inject(BetsService) private readonly bets: BetsService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(GameSessionService) private readonly sessions: GameSessionService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(ElectionService) private readonly election: ElectionService,
    @Inject(WalletRollbackService) private readonly walletRollbacks: WalletRollbackService,
    // Raw operator client (null in internal mode) — the M1 rollback-outbox drain re-emits
    // through it; null makes the drain a no-op (no operator to call).
    @Inject(OPERATOR_WALLET_API) private readonly operatorApi: OperatorWalletApi | null,
  ) {}

  afterInit(server: Server) {
    // Phase 4.5b: the engine `events` only ever fire on the LEADER node (a follower has no
    // engine loop), so these relays are already effectively leader-driven; the Redis IO
    // adapter fans the leader's server.emit out to clients on EVERY node, which is why
    // followers need no tick of their own. The leader-only *work* below (onTick auto-cashout
    // driver, onSettle settlement, reconcile + reserving sweeps) is additionally gated on
    // election.isLeader() so exactly one node does shared-DB work — even though the timers
    // are armed on every node (so leadership can flip at runtime without re-wiring).
    const e = this.engine.events;
    e.on("phase", (s) => server.emit("round_state", s));
    e.on("crash", (p) => server.emit("round_crashed", p));
    e.on("settle", (p) => this.onSettle(p));
    e.on("settled", (p) => server.emit("round_settled", p));

    // Phase 4.5c.2 — give the engine an AWAITABLE auto-cashout driver for its seamless
    // failover-resume. When a survivor resumes a round whose crash elapsed during the
    // failover gap, the engine must pay every due auto-cashout (target < crashPoint) at its
    // target BEFORE revealing the crash. The engine has no BetsService (it injects the
    // engine — a cycle), so we hand it the same evaluateAutoCashouts the onTick loop uses;
    // the engine awaits it deterministically, then crashes. This only fires on resume — the
    // normal running loop still drives autos through onTick. afterInit runs before any
    // leader-acquired start(), so the driver is always registered before a resume can occur.
    // LOAD-BEARING ORDERING: this driver AND the `onSettle` settle-wiring above are registered
    // here in afterInit (OnGatewayInit), which Nest runs DURING init — strictly before
    // ElectionService's first acquire in onApplicationBootstrap fires `leader-acquired`→start()
    // →resume. So both seams are always wired before any resume can call them. If that first
    // acquire were ever moved back to onModuleInit, the honor-pay (running-resume) and the
    // settling-resume settle would silently fall through to the onTick fallback.
    this.engine.setAutoCashoutDriver((m) => this.bets.evaluateAutoCashouts(m));

    this.interval = setInterval(() => this.onTick(), 120);
    // H2: in operator mode, retry payouts stuck in payout_pending (a won cash-out
    // whose operator credit we couldn't confirm) — a sweep at startup (recovers
    // promptly after a restart) then every 30s. No-op otherwise.
    if (process.env.WALLET_PROVIDER_TYPE === "operator") {
      void this.runReconcile();
      this.reconcileInterval = setInterval(() => void this.runReconcile(), 30_000);
    } else {
      // Off operator mode the reconciler doesn't run — but payout_pending rows can
      // exist (left by a prior operator-mode run, or operator mode toggled off
      // with a backlog). They're owed wins that WON'T be reconciled until operator
      // mode is back on, so make that loud at boot. (No retry here — wrong wallet.)
      void this.bets
        .countPendingPayouts()
        .then((n) => {
          if (n > 0) {
            this.log.error(
              `${n} payout_pending bet(s) exist but WALLET_PROVIDER_TYPE is not "operator" — ` +
                `these owed payouts will NOT be reconciled until operator mode is enabled.`,
            );
          }
        })
        .catch(() => {
          /* boot-time DB hiccup — don't crash the gateway over a diagnostic count */
        });
    }

    // Operator-hardening: a 'reserving' slot can be stranded mid-run (the debit
    // applied but the flip to active failed and was left recoverable). Boot recovery
    // heals it, but only on restart — sweep periodically so it self-heals WITHOUT a
    // reboot, in BOTH wallet modes (internal refunds via the ledger; operator via an
    // idempotent rollback). Age-gated (RESERVING_STALE_SEC, default 120s) so a placeBet
    // legitimately in flight is NEVER touched — only genuinely stranded slots.
    const reservingStaleMs = resolveReservingStaleMs(process.env.RESERVING_STALE_SEC);
    this.reservingSweepInterval = setInterval(() => void this.runReservingSweep(reservingStaleMs), 60_000);

    // Phase 3 RG: a phase-independent ~5s sweep emits reality checks + trips session
    // time limits per live socket. A no-op for sockets with no `rg` (guests/demo/
    // non-RG operators), so it's cheap regardless of wallet mode.
    this.rgSweepInterval = setInterval(() => void this.runRgSweep(), 5_000);
  }

  /** Reconcile pending payouts, guarded against overlapping cycles — a slow cycle
   *  over a degraded operator can run longer than the 30s interval (audit H2).
   *  LEADER-ONLY (Phase 4.5b): touches the shared DB, so exactly one node runs it. */
  private async runReconcile() {
    if (!this.election.isLeader()) return;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.bets.reconcilePendingPayouts();
    } catch {
      /* per-bet failures are already recorded inside reconcilePendingPayouts */
    } finally {
      this.reconciling = false;
    }
  }

  /** Periodic, age-gated 'reserving' recovery (BOTH wallet modes) — self-heals a
   *  mid-run stranded reservation without a reboot. Guarded against overlap so a
   *  slow pass can't stack. Per-bet errors are logged inside the engine method.
   *  LEADER-ONLY (Phase 4.5b): touches the shared DB (and the engine's recover path
   *  refunds money), so exactly one node runs it — this is the multi-instance
   *  sweep-ownership lock the design called for. */
  private async runReservingSweep(olderThanMs: number) {
    if (!this.election.isLeader()) return;
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.engine.recoverReservingBets(olderThanMs);
      await this.bets.reportReservingBacklog(); // refresh the backlog gauges + alert on stuck (Low-4)
      // Phase 6: self-heal any operator void stranded mid-reversal (status 'voiding') by
      // re-running its idempotent reversals + finalising — both wallet modes. Leader-gated
      // (shared DB + money) by the guard above; alerts on anything still stuck.
      await this.bets.reconcileVoidingBets();
      // M1 (F-027): drain the durable operator-rollback outbox — re-emit any rollback whose
      // operator call previously failed, until it confirms. A no-op in internal mode
      // (operatorApi is null → drainPending returns 0). Leader-gated by the guard above.
      await this.walletRollbacks.drainPending(this.operatorApi);
      // Reflect the live owed-rollback backlog on the gauge (drops to 0 once drained).
      this.metrics.setWalletRollbackPending(await this.walletRollbacks.countPending());
    } catch (e: any) {
      // Per-bet failures are already logged inside recoverReservingBets; this catches a
      // top-level failure (e.g. the findMany itself on a DB blip) so it isn't silent.
      this.log.warn(`reserving sweep failed: ${e?.message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Phase-independent RG sweep (Phase 3): for each live socket carrying an `rg`
   *  context, emit reality checks on the configured interval and trip the session time
   *  limit ONCE. Guarded against overlap; a no-op for non-RG sockets (guests/demo).
   *  The reality-check payload carries the session's wagered/won/net (derived from bets). */
  private async runRgSweep() {
    if (this.rgSweeping) return;
    this.rgSweeping = true;
    const now = Date.now();
    try {
      // F-068 — re-check liveness for THIS node's CONNECTED operator sockets and drop any whose
      // session is now revoked (so a force-revoke severs an already-connected socket, not just
      // future reconnects). Runs on EVERY node (each node owns its own sockets — a non-leader
      // still holds operator sockets), NOT leader-gated. BATCHED: one query for all connected
      // operator session ids (no N+1 per socket). place_bet also re-checks revoke, so the next
      // bet is rejected even before this sweep disconnects the socket (defense-in-depth).
      await this.disconnectRevokedSockets();

      for (const [userId, socketId] of this.userSockets) {
        const sock = this.server.sockets.sockets.get(socketId);
        const rg = sock?.data?.rg as EffectiveRg | undefined;
        const startedAt = sock?.data?.sessionStartedAt as number | undefined;
        if (!sock || !rg || startedAt === undefined) continue;

        const decision = rgEvaluate(
          {
            rg,
            sessionStartedAt: startedAt,
            rgRealityDueAt: sock.data.rgRealityDueAt as number | undefined,
            rgPending: sock.data.rgPending === true,
            rgTimeLimitNotified: sock.data.rgTimeLimitNotified === true,
          },
          now,
        );
        // Commit the next per-socket state.
        sock.data.rgRealityDueAt = decision.nextDueAt;
        sock.data.rgPending = decision.nextPending;
        sock.data.rgTimeLimitNotified = decision.nextTimeLimitNotified;

        if (decision.tripTimeLimit) {
          this.server.to(userRoom(userId)).emit("session_time_limit", { maxSessionSec: rg.maxSessionSec });
        }
        if (decision.emitRealityCheck) {
          const walletId = sock.data.walletId as string | undefined;
          let acc = { wagered: 0n, won: 0n, net: 0n };
          if (walletId) {
            try {
              acc = await this.bets.sessionAccounting(walletId, new Date(startedAt));
            } catch (e: any) {
              this.log.warn(`RG accounting failed for ${userId}: ${e?.message}`);
            }
          }
          this.server.to(userRoom(userId)).emit("reality_check", {
            elapsedSec: Math.max(0, Math.floor((now - startedAt) / 1000)),
            wagered: Number(acc.wagered),
            won: Number(acc.won),
            net: Number(acc.net),
            currency: (sock.data.currency as string) ?? "DEMO",
            enforce: rg.enforceRealityCheck,
          });
          // F-067 — PERSIST the fired check on the GameSession so the hard-pause + the advanced
          // due clock survive a reconnect. In enforce mode `nextPending` is true → persist
          // realityCheckPendingAt (a reconnect re-arms rgPending until ack). In notify mode there's
          // no pause, but we still persist the advanced due time so the reconnect resumes the same
          // schedule. Best-effort (the in-memory rgPending already gates this socket); a failure
          // is logged, never thrown — it must not break the sweep for other sockets.
          const sessionId = sock.data.sessionId as string | undefined;
          if (sessionId) {
            try {
              if (decision.nextPending) {
                await this.sessions.markRealityCheckPending(sessionId, decision.nextDueAt);
              } else {
                // notify mode (no pause) — just advance the persisted due clock (ack semantics).
                await this.sessions.ackRealityCheck(sessionId, decision.nextDueAt);
              }
            } catch (e: any) {
              this.log.warn(`RG reality-check persist failed for session ${sessionId}: ${e?.message}`);
            }
          }
        }
      }
    } catch (e: any) {
      this.log.warn(`RG sweep failed: ${e?.message}`);
    } finally {
      this.rgSweeping = false;
    }
  }

  /** F-068 — drop THIS node's connected operator sockets whose session is now revoked (an
   *  operator force-revoke, or a player logout). Iterates the node's own connected sockets,
   *  collects their session ids, BATCH-checks which are no-longer-live in ONE query (no N+1),
   *  and disconnect(true)s the dead ones. Guests (no sessionId) are skipped. A connected
   *  socket whose session vanished/was-revoked is severed mid-session — future reconnects are
   *  already refused by the connect-time isLive() check. */
  private async disconnectRevokedSockets() {
    // Map session id → the socket ids carrying it (normally 1; defensive for duplicates).
    const bySession = new Map<string, string[]>();
    for (const socketId of this.userSockets.values()) {
      const sock = this.server.sockets.sockets.get(socketId);
      const sessionId = sock?.data?.sessionId as string | undefined;
      if (!sock || !sessionId) continue;
      const list = bySession.get(sessionId);
      if (list) list.push(socketId);
      else bySession.set(sessionId, [socketId]);
    }
    if (bySession.size === 0) return;
    const notLive = await this.sessions.findNotLive([...bySession.keys()]);
    for (const sessionId of notLive) {
      for (const socketId of bySession.get(sessionId) ?? []) {
        this.server.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    if (this.reservingSweepInterval) clearInterval(this.reservingSweepInterval);
    if (this.rgSweepInterval) clearInterval(this.rgSweepInterval);
  }

  async handleConnection(client: Socket) {
    // Optional auth: a JWT in the handshake lets this socket place bets.
    const token = (client.handshake.auth as any)?.token as string | undefined;
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync(token);
        // An operator session token must still map to a LIVE GameSession (audit L-C2.2):
        // a revoked/removed session is rejected even if its short-lived JWT hasn't
        // expired yet. Guests carry no sessionId and skip this.
        if (payload.kind === "operator" && payload.sessionId) {
          const live = await this.sessions.isLive(payload.sessionId as string);
          if (!live) throw new Error("session_not_live");
        }
        const userId = payload.sub as string;
        client.data.userId = userId;
        // An operator session token binds a specific journal wallet — placeBet resolves
        // THIS wallet (audit M-C2.1). Guests carry no walletId → resolve by userId.
        if (payload.walletId) client.data.walletId = payload.walletId as string;
        // Phase 3: the operator play token may carry the session's per-currency bet
        // limits; deserialize once (null/absent → global house defaults) and apply per bet.
        const lim = deserializeBetLimits((payload as any).limits);
        if (lim) client.data.limits = lim;
        // Phase 3: play-money fun-mode marker from OUR signed play token → stamped on
        // the bet row. The actual money routing is by walletId (WalletRouter), so this
        // flag only labels the bet; it can't move money to the wrong source.
        client.data.demo = (payload as any).demo === true;
        // Phase 3 RG: in-session responsible-gambling context (real sessions carry an
        // `rg` claim; demo/guests don't). sessionId/currency were previously dropped.
        client.data.sessionId = (payload as any).sessionId;
        client.data.currency = (payload as any).currency;
        // Phase 3.5: operatorId from the verified play token → denormalised onto each
        // bet for per-operator reporting (guests carry none → stays undefined).
        client.data.operatorId = (payload as any).operatorId;
        const rgStartedAt = Number((payload as any).sessionStartedAt);
        const rg = deserializeRg((payload as any).rg);
        if (rg && Number.isFinite(rgStartedAt)) {
          client.data.sessionStartedAt = rgStartedAt;
          client.data.rg = rg;
          client.data.rgTimeLimitNotified = false;
          // F-067 — RELOAD the reality-check state from the persisted GameSession row instead of
          // blindly clearing the hard-pause + resetting the clock. A pending check (set when it
          // fired) SURVIVES this reconnect (rgPending stays true → place_bet stays blocked until
          // ack); the due clock resumes from the persisted value (a reconnect does NOT reset it to
          // a fresh full interval). Brand-new session (no persisted due) → fall back to the
          // token-derived due. The pause is cleared ONLY by reality_check_ack, never on connect.
          // The session TIME limit is unaffected — it's computed from the immutable rgStartedAt.
          let restored: { pending: boolean; dueAt?: number } = { pending: false };
          if (rg.realityCheckIntervalSec && payload.sessionId) {
            try {
              restored = await this.sessions.loadRealityCheckState(payload.sessionId as string);
            } catch (e: any) {
              // A DB hiccup at connect must FAIL CLOSED on the pause (assume pending) so a
              // reconnect can never silently dodge an in-flight reality check; the due time
              // then falls back to the token-derived value. Loud so it's not silent.
              this.log.warn(`RG reality-check reload failed for session ${payload.sessionId}; assuming pending: ${e?.message}`);
              restored = { pending: true };
            }
          }
          client.data.rgPending = restored.pending;
          client.data.rgRealityDueAt =
            restored.dueAt ??
            (rg.realityCheckIntervalSec ? rgStartedAt + rg.realityCheckIntervalSec * 1000 : undefined);
        } else if (rg) {
          // A signed token carried RG but no usable sessionStartedAt — impossible via the
          // real mint path (both are set together), so log it so a future regression that
          // would silently drop the RG controls is visible rather than failing open quietly.
          this.log.warn(`operator session token carried RG but no valid sessionStartedAt — RG NOT applied for user ${userId}`);
        }
        client.join(userRoom(userId));
        // one active game socket per user — drop any previous one (multi-tab abuse)
        const prev = this.userSockets.get(userId);
        if (prev && prev !== client.id) {
          this.server.sockets.sockets.get(prev)?.disconnect(true);
        }
        this.userSockets.set(userId, client.id);
      } catch {
        /* unauthenticated — read-only */
      }
    }
    const s = this.engine.getPublicState();
    if (s) client.emit("round_state", s);
    // metrics-only: live socket count from the server's own registry (Phase 4.4).
    this.metrics.setWsConnections(this.server.sockets.sockets.size);
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId && this.userSockets.get(userId) === client.id) {
      this.userSockets.delete(userId);
    }
    this.msgRate.delete(client.id);
    // metrics-only: reflect the live socket count, excluding THIS disconnecting socket.
    // socket.io may already have removed it from the map by now (then size is correct);
    // if not, subtract it. Floor at 0 so a mass-disconnect can never drive the gauge
    // negative (Phase 4.4).
    const size = this.server.sockets.sockets.size;
    const live = this.server.sockets.sockets.has(client.id) ? size - 1 : size;
    this.metrics.setWsConnections(Math.max(0, live));
  }

  // ---- realtime drivers ----
  // LEADER-ONLY (Phase 4.5b): exactly one node computes the multiplier, broadcasts it
  // (the Redis adapter delivers to clients on ALL nodes), and drives auto-cashouts (a
  // money action over the shared DB). A follower must NOT tick — it would double-emit
  // cluster-wide and double-scan auto-cashouts.
  private async onTick() {
    if (!this.election.isLeader()) return;
    const s = this.engine.getPublicState();
    if (!s || s.phase !== "running") return;
    this.server.emit("multiplier_update", {
      roundId: s.roundId,
      multiplier: s.multiplier,
      serverTime: s.serverTime,
    });
    const cashed = await this.bets.evaluateAutoCashouts(s.multiplier);
    for (const c of cashed) {
      this.server.to(userRoom(c.userId!)).emit("cashout_accepted", {
        panel: c.panel,
        multiplier: c.multiplier,
        payout: c.payout,
        auto: true,
        pending: c.pending,
      });
      // Don't emit a balance when the payout is unconfirmed (operator-mode pending).
      if (c.balance !== undefined) {
        this.server.to(userRoom(c.userId!)).emit("balance_updated", { currency: c.currency ?? "DEMO", balance: c.balance });
      }
    }
  }

  private async onSettle(p: { roundId: string }) {
    // LEADER-ONLY (Phase 4.5b): settlement is initiated only by the leader's engine loop.
    // The engine `settle` event only fires on the leader anyway (a follower has no loop);
    // the explicit gate is defense-in-depth so a follower can never initiate settle.
    // settleRound is itself idempotent (CAS on status=active), so this is belt-and-suspenders.
    if (!this.election.isLeader()) return;
    // metrics-only: time the crash-leg settlement (crash → busted bets committed)
    // into the shared settlement histogram (Phase 4.4, decision §2 Option A).
    const t0 = Date.now();
    const busted = await this.bets.settleRound(p.roundId);
    this.metrics.observeSettlementLatency(Date.now() - t0);
    for (const b of busted) {
      this.server.to(userRoom(b.userId)).emit("bet_busted", { panel: b.panel });
    }
  }

  // ---- client → server ----
  @SubscribeMessage("subscribe_round")
  onSubscribe(@ConnectedSocket() client: Socket) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const s = this.engine.getPublicState();
    if (s) client.emit("round_state", s);
    return { ok: true };
  }

  /**
   * Phase 4.2 clock-sync: NTP-style time exchange over the WS ack. The client
   * sends `t0` (its send time) and measures RTT around the ack; the server stamps
   * `serverTime`. The client derives a latency-corrected server-time offset so
   * phase countdowns (`phaseEndsAt`) stay aligned across LB'd nodes/regions. Leaks
   * nothing but the server clock; rate-limited like every other message. No auth
   * required (guests need aligned countdowns too).
   */
  @SubscribeMessage("time_sync")
  onTimeSync(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const parsed = timeSyncSchema.safeParse(body);
    const t0 = parsed.success ? (parsed.data.t0 ?? null) : null;
    return { ok: true, t0, serverTime: Date.now() };
  }

  @SubscribeMessage("place_bet")
  async onPlaceBet(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = placeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const { panel, amount, autoCashout } = parsed.data;
    // F-068 defense-in-depth: an operator session token is re-validated against a LIVE
    // GameSession on EVERY new bet (not just at connect), so a bet placed on an already-
    // connected socket AFTER an operator force-revoke is rejected immediately — before the
    // RG sweep gets around to disconnecting the socket. Guests carry no sessionId → skipped
    // (no operator session to revoke). cash_out/cancel are intentionally NOT gated here so
    // an at-risk player can always get money out of an in-flight bet.
    const sessionId = client.data.sessionId as string | undefined;
    if (sessionId) {
      const live = await this.sessions.isLive(sessionId).catch(() => true); // DB blip → don't fail-closed-block a legit bet; the connect gate + sweep still hold
      if (!live) return { ok: false, reason: "session_revoked", panel };
    }
    const walletId = client.data.walletId as string | undefined;
    const limits = client.data.limits as PerBetLimits | undefined;
    const demo = client.data.demo as boolean | undefined;
    // Phase 3 RG: session-scoped controls (real sessions only; rg is undefined for
    // demo/guests so placeBet skips RG). The pending flag is set by the reality-check sweep.
    const rgCtx = {
      rg: client.data.rg as EffectiveRg | undefined,
      rgPending: client.data.rgPending === true,
      sessionStartedAt: client.data.sessionStartedAt as number | undefined,
    };
    // Phase 3.5: stamp the operator on the bet row (reporting). Guests → undefined.
    const betCtx = { operatorId: client.data.operatorId as string | undefined };
    const r = await this.bets.placeBet(userId, panel as Panel, amount, autoCashout, walletId, limits, demo, rgCtx, betCtx);
    const event = r.ok ? "bet_accepted" : "bet_rejected";
    client.emit(event, r);
    if (r.ok && r.balance !== undefined) {
      client.emit("balance_updated", { currency: r.currency ?? "DEMO", balance: r.balance });
    }
    return r;
  }

  @SubscribeMessage("cancel_bet")
  async onCancelBet(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = panelSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const r = await this.bets.cancelBet(userId, parsed.data.panel as Panel);
    client.emit(r.ok ? "bet_cancelled" : "bet_rejected", r);
    if (r.ok && r.balance !== undefined) {
      client.emit("balance_updated", { currency: r.currency ?? "DEMO", balance: r.balance });
    }
    return r;
  }

  @SubscribeMessage("cash_out")
  async onCashOut(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = panelSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const r = await this.bets.cashOut(userId, parsed.data.panel as Panel);
    client.emit(r.ok ? "cashout_accepted" : "cashout_rejected", r);
    if (r.ok && r.balance !== undefined) {
      client.emit("balance_updated", { currency: r.currency ?? "DEMO", balance: r.balance });
    }
    return r;
  }

  /** Phase 3 RG: the player acknowledged a reality check → unblock new bets and reset
   *  the interval from now (the next check fires `interval` seconds after this ack). F-067:
   *  the cleared pause + advanced clock are ALSO persisted on the GameSession so a reconnect
   *  doesn't resurrect a stale pending (the pause is lifted ONLY here, never on connect). */
  @SubscribeMessage("reality_check_ack")
  async onRealityCheckAck(@ConnectedSocket() client: Socket) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const rg = client.data.rg as EffectiveRg | undefined;
    if (!client.data.userId || !rg) return { ok: false, reason: "not_authenticated" };
    client.data.rgPending = false;
    const nextDueAt = rg.realityCheckIntervalSec ? Date.now() + rg.realityCheckIntervalSec * 1000 : undefined;
    if (nextDueAt !== undefined) client.data.rgRealityDueAt = nextDueAt;
    // Persist the ack (clear pending + stamp ack + advance due) so the reconnect path reloads a
    // NON-pending state. Best-effort: the in-memory clear already unblocks this live socket; a DB
    // failure here is logged, not surfaced — the next sweep/reconnect reconciles.
    const sessionId = client.data.sessionId as string | undefined;
    if (sessionId) {
      try {
        await this.sessions.ackRealityCheck(sessionId, nextDueAt);
      } catch (e: any) {
        this.log.warn(`RG reality-check ack persist failed for session ${sessionId}: ${e?.message}`);
      }
    }
    return { ok: true };
  }
}
