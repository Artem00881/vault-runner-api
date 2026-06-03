import { Inject, OnModuleDestroy } from "@nestjs/common";
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
import { placeSchema, panelSchema } from "./ws-schemas";

function userRoom(userId: string) {
  return `user:${userId}`;
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
  private interval: ReturnType<typeof setInterval> | null = null;
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private reconciling = false; // guards against overlapping reconcile cycles (H2)
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
  ) {}

  afterInit(server: Server) {
    const e = this.engine.events;
    e.on("phase", (s) => server.emit("round_state", s));
    e.on("crash", (p) => server.emit("round_crashed", p));
    e.on("settle", (p) => this.onSettle(p));
    e.on("settled", (p) => server.emit("round_settled", p));

    this.interval = setInterval(() => this.onTick(), 120);
    // H2: in operator mode, retry payouts stuck in payout_pending (a won cash-out
    // whose operator credit we couldn't confirm) — a sweep at startup (recovers
    // promptly after a restart) then every 30s. No-op otherwise.
    if (process.env.WALLET_PROVIDER_TYPE === "operator") {
      void this.runReconcile();
      this.reconcileInterval = setInterval(() => void this.runReconcile(), 30_000);
    }
  }

  /** Reconcile pending payouts, guarded against overlapping cycles — a slow cycle
   *  over a degraded operator can run longer than the 30s interval (audit H2). */
  private async runReconcile() {
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

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
  }

  async handleConnection(client: Socket) {
    // Optional auth: a JWT in the handshake lets this socket place bets.
    const token = (client.handshake.auth as any)?.token as string | undefined;
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync(token);
        const userId = payload.sub as string;
        client.data.userId = userId;
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
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId && this.userSockets.get(userId) === client.id) {
      this.userSockets.delete(userId);
    }
    this.msgRate.delete(client.id);
  }

  // ---- realtime drivers ----
  private async onTick() {
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
    const busted = await this.bets.settleRound(p.roundId);
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

  @SubscribeMessage("place_bet")
  async onPlaceBet(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    if (!this.allow(client)) return { ok: false, reason: "rate_limited" };
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = placeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const { panel, amount, autoCashout } = parsed.data;
    const r = await this.bets.placeBet(userId, panel as Panel, amount, autoCashout);
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
}
