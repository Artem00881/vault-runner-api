import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { FairnessService } from "../fairness/fairness.service";
import { WALLET_PROVIDER, type WalletProvider } from "../wallet/wallet-provider";
import { MetricsService } from "../metrics/metrics.service";
import { ElectionService } from "../ha/election.service";
import { captureException } from "../observability/sentry";
import { PublicRoundCache, ROUND_CHANNEL, ROUND_SNAPSHOT_KEY, type PublishedRoundState } from "./public-round-cache";
import { GROWTH, PHASE_MS, type Phase, type PublicRoundState } from "./round-types";

// Re-export the shared round value-types so existing importers (and callers that did
// `import { GROWTH, PublicRoundState } from "./game-engine.service"`) keep working. The
// definitions live in ./round-types to avoid an engine↔cache require() cycle (4.5b).
export { GROWTH, PHASE_MS, type Phase, type PublicRoundState };

interface EngineState {
  roundId: string;
  seedId: string;
  phase: Phase;
  phaseEndsAt: number;
  startedAt: number | null;
  crashPoint: number; // SECRET — never exposed before the crash
}

/** The non-terminal round statuses — a round in any of these still owns open state. */
const OPEN_PHASES: Phase[] = ["waiting", "betting", "running", "crashed", "settling"];

/**
 * Phase 4.5c.2 — resume staleness bound (ms). SCOPE: this bound gates the PRE-OUTCOME phases
 * waiting + betting ONLY (enforced in unresumableReason). Those phases have no deterministic
 * result yet and owe no money — they are merely counting down to the next transition against a
 * live betting window / multiplier curve. On boot/failover we RESUME such a round only if its
 * phaseEndsAt is still live or only just elapsed; if that deadline passed more than this long
 * ago the round is treated as ANCIENT (a long process downtime, a clock jump, or a corrupt row)
 * and is close+refunded + restarted fresh instead (betting refunds the live bets that can no
 * longer fairly run; waiting has none, so it just starts fresh).
 *
 * The POST-OUTCOME phases running / crashed / settling are DELIBERATELY NOT bounded here: a
 * crash that already happened (or is mid-flight) is fully deterministic and real money is owed
 * on it (autos with target<crashPoint won, the rest busted), so resumeRound HONORS + FINISHES
 * them regardless of age — never staleness-rejected.
 *
 * WHY a bound at all: resume re-attaches setTimeouts to absolute persisted epoch-ms deadlines.
 * After a genuine failover the survivor takes over in <5s (leader-election SLA), so every live
 * deadline is at most a few seconds stale — well inside this window — and the round resumes
 * seamlessly. But a node DOWN for minutes/hours would otherwise "resume" a waiting/betting round
 * whose window is long gone: there is no live curve to climb back into and clients have moved
 * on, so refund-and-restart is the only correct, non-surprising outcome. 30s is comfortably
 * above the failover budget yet far below a round's total lifetime (~11.6s + run), so a real
 * failover always resumes and only a true outage refunds.
 */
const RESUME_MAX_STALENESS_MS = 30_000;

function numEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Audit H5 / F-048a — PER-PHASE await deadline (ms). Each phase transition's awaited work is
 * raced against this; if it never settles (a HUNG await — e.g. a wedged DB connection, the
 * silent-stall root cause) the race REJECTS, safe()'s catch fires, and the loop reschedules a
 * fresh enterWaiting() instead of stalling forever. Phases are normally sub-second; the worst
 * legitimate case is a resume honor-then-crash settling many bets. The 10s default is
 * comfortably above any real phase yet far below the multi-minute stall window, and ABOVE the
 * 8s DB statement_timeout (F-048b) so a wedged query rejects on its own first — this deadline
 * is the backstop for a hang with no query to time out. Changes NO fairness logic: re-entering
 * enterWaiting allocates a fresh seed idempotently. Read at USE time (not frozen at module
 * load) so fault-injection tests can set ENGINE_PHASE_DEADLINE_MS per-run without import-order
 * fragility; production reads it once-effectively (the env is fixed for the process lifetime).
 */
const phaseDeadlineMs = () => numEnv("ENGINE_PHASE_DEADLINE_MS", 10_000);

/**
 * Audit H5 / F-048c — round-liveness DEADMAN window (ms). If we are the leader and no round
 * has COMPLETED within this long, the loop is wedged in a way the per-phase deadline did not
 * self-heal (e.g. reschedule itself keeps failing). The deadman then logs loudly, records the
 * stall metric, and VOLUNTARILY steps down so a healthy follower takes over via the proven
 * failover-resume. Kept WELL ABOVE the per-phase deadline (#1 self-heals first; this is the
 * backstop) and far below the 15-min EngineStalled alert window. A full round is ~11.6s + run
 * time, so 60s spans several rounds — a true stall, never a slow one. Read at use time; override
 * via ENGINE_DEADMAN_MS (tests).
 */
const deadmanMs = () => numEnv("ENGINE_DEADMAN_MS", 60_000);
/** How often the deadman checks liveness (ms). Sub-deadline so it reacts within a check tick. */
const deadmanCheckMs = () => numEnv("ENGINE_DEADMAN_CHECK_MS", 10_000);

@Injectable()
export class GameEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(GameEngineService.name);
  /** phase / tick / crash / settled events for the WS gateway (M5). */
  readonly events = new EventEmitter();

  private state: EngineState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /**
   * F-048c — wall-clock ms of the last COMPLETED round (the liveness anchor the deadman + the
   * /health/live probe read). Seeded to construction time so a freshly-started leader gets a
   * full DEADMAN_MS grace before the first round completes (boot/resume legitimately takes a
   * few seconds). Stamped in enterCompleted(), the single point a round truly finishes.
   */
  private lastRoundAt = Date.now();
  /** F-048c deadman timer (leader-only; armed in start(), cleared in stop()). */
  private deadmanTimer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard so an in-flight voluntary step-down can't be triggered twice. */
  private steppingDown = false;

  /**
   * Phase 4.5c.2 — optional auto-cashout driver, registered by the gateway (which owns
   * BetsService). The engine deliberately has NO BetsService dependency (BetsService injects
   * the engine — a forwardRef cycle otherwise; the gateway is the money-action driver via
   * onTick/onSettle). The resume path's honor-then-crash branch needs to AWAIT the due
   * auto-cashouts BEFORE revealing the crash; it does so through this hook so the engine
   * stays decoupled. Returns the number paid (unused). When unregistered (should not happen
   * — afterInit runs before any leader-acquired start()), the periodic onTick still honors
   * the autos, just less deterministically, so the fallback is safe, only less tidy.
   */
  private autoCashoutDriver: ((multiplier: number) => Promise<unknown>) | null = null;

  /** Register the auto-cashout driver (gateway.afterInit). Idempotent — last writer wins. */
  setAutoCashoutDriver(fn: (multiplier: number) => Promise<unknown>) {
    this.autoCashoutDriver = fn;
  }

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(FairnessService) private readonly fairness: FairnessService,
    @Inject(WALLET_PROVIDER) private readonly wallet$: WalletProvider,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(ElectionService) private readonly election: ElectionService,
    @Inject(PublicRoundCache) private readonly cache: PublicRoundCache,
  ) {}

  onModuleInit() {
    // The engine NO LONGER self-starts on GAME_AUTOSTART. Leadership drives it:
    //  - subscribe so a later acquire starts us / a loss stops us;
    //  - AND if election already acquired (DI/bootstrap ordering let it win the lock
    //    before this listener attached), start now so a single node can't miss it.
    // Net single-node behavior is identical: one node wins the lock on boot → start().
    this.election.events.on("leader-acquired", () => {
      this.log.log("became engine leader → starting the round loop");
      this.metrics.setEngineLeader(this.election.nodeId, true); // F-050 leader gauge + flap counter
      this.start().catch((e) => this.log.error(`start failed: ${e?.message}`));
    });
    this.election.events.on("leader-lost", () => {
      this.log.warn("lost engine leadership → stopping the round loop");
      this.metrics.setEngineLeader(this.election.nodeId, false); // F-050 follower gauge + flap counter
      this.stop();
    });
    // F-050: publish an initial leader/follower reading at boot (before any flip) so the gauge
    // exists from the first scrape, not only after the first transition.
    this.metrics.setEngineLeader(this.election.nodeId, this.election.isLeader());
    if (this.election.isLeader()) {
      this.start().catch((e) => this.log.error(`start failed: ${e?.message}`));
    }
  }

  onModuleDestroy() {
    this.stop();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // F-048c: a fresh leader gets a full grace window before the deadman can trip (boot/resume
    // legitimately takes a few seconds to complete the first round), then arm the deadman.
    this.lastRoundAt = Date.now();
    this.steppingDown = false;
    this.armDeadman();
    await this.fairness.ensureChain();
    // F-083: on EVERY production boot, finalize any bet stranded 'active' on a prior refund-all
    // (completed/pre-outcome) round whose closeAndRefundRound reverse() had failed. This is the
    // authoritative boot heal (start() resumes via resumeOrRecover() below, which does NOT call the
    // test-only recoverInterruptedRounds()). No age gate — boot recovery is single-threaded, not
    // racing a live close; the periodic gateway sweep continues to heal at runtime. Idempotent.
    await this.recoverStrandedActiveBets(0);
    // Phase 4.5c.2: RESUME the in-flight round (seamless failover) instead of always
    // close+refunding it. resumeOrRecover() either re-attaches the loop to the persisted
    // round and continues from the correct phase, or — for an anomalous/corrupt/ancient
    // row — falls back to the SAFE close+refund path and starts fresh. On a clean DB it
    // finds no open round and simply opens a new one (single-node behavior unchanged).
    if (await this.resumeOrRecover()) {
      this.log.log("Game engine started (resumed in-flight round)");
      return; // resumeRound() already armed the next transition — do NOT also enterWaiting()
    }
    this.log.log("Game engine started");
    await this.enterWaiting();
  }

  /**
   * Crash-safe restart: a round left in betting/running/crashed/settling when the
   * process died is "zombie" — the in-memory loop is gone but the DB row + its
   * bets are still open. This is the SAFE FALLBACK path: it closes every such round
   * and refunds its still-active bets (idempotent `bet:{id}:restart_refund`, so a
   * double boot can't double-pay). Phase 4.5c.2 prefers resumeOrRecover() (which
   * RESUMES a clean candidate), but this remains both (a) the direct close+refund
   * primitive the resume path calls for anomalies, and (b) the historical entry point
   * still exercised by tests. Kept find-ALL-open so calling it bare closes everything.
   */
  private async recoverInterruptedRounds() {
    // H1: refund/clear stale 'reserving' bets first (regardless of round status).
    await this.recoverReservingBets();
    // F-083: also heal stranded-'active' refund-all bets here (this method is the test entry point
    // AND the resume-anomaly fallback primitive). The authoritative production boot heal is in
    // start() before resumeOrRecover(); this call is idempotent so the overlap is harmless.
    await this.recoverStrandedActiveBets(0);
    const stuck = await this.prisma.round.findMany({
      where: { status: { in: OPEN_PHASES as string[] } },
      select: { id: true },
    });
    if (stuck.length === 0) return;
    this.log.warn(`recovering ${stuck.length} interrupted round(s) from a restart`);
    for (const r of stuck) await this.closeAndRefundRound(r.id);
  }

  /**
   * Close ONE open round and refund its still-active bets — the shared close+refund
   * primitive used by recoverInterruptedRounds() AND by the resume path's fallback for
   * anomalous/corrupt rows. F-003: the refund goes through `wallet$.reverse` (rollback-of-
   * original), so in OPERATOR mode it rolls back the original stake-debit (no GGR-inflating
   * `win`); in INTERNAL mode it posts a `refund` credit under the idempotent
   * `bet:{id}:restart_refund` key (unchanged behaviour), so a double boot (or a resume that
   * later re-closes) can never double-pay. Only `active` bets carry a live debit to refund;
   * cashed_out/busted/cancelled are
   * terminal and untouched. The round is force-marked `completed` (it never reached a real
   * settlement). NOTE: this refunds — it does NOT honor a deterministic crash — so it is
   * only ever used when a round is UNRESUMABLE (corrupt/ancient/anomalous), never as the
   * normal path for a healthy in-flight round.
   */
  private async closeAndRefundRound(roundId: string) {
    const activeBets = await this.prisma.bet.findMany({
      where: { roundId, status: "active" },
      // F-003: select the bet's (round,user,panel) so we can target the ORIGINAL stake-debit
      // key for the reversal below (mirrors the void-refund leg in performVoidReversals).
      select: { id: true, walletId: true, amount: true, roundId: true, userId: true, panel: true },
    });
    for (const bet of activeBets) {
      try {
        // F-003: refund the still-`active` stake via REVERSE (rollback-of-original), NOT a fresh
        // credit. In OPERATOR mode a credit routed to `move("win")`, recording a brand-new
        // win/turnover and inflating GGR; the correct accounting is to roll back the original
        // `…:debit` on the operator's statement (no new turnover) — exactly what a void refund
        // does. In INTERNAL/demo mode this is behaviourally identical to before: the ledger posts
        // a `refund` CREDIT under the same `bet:{id}:restart_refund` key (idempotent — a double
        // boot still can't double-pay). Mirrors performVoidReversals' stake-refund leg.
        await this.wallet$.reverse(bet.walletId, {
          originalKey: `bet:${bet.roundId}:${bet.userId}:${bet.panel}:debit`,
          reverseKey: `bet:${bet.id}:restart_refund`,
          amount: bet.amount,
          originalDirection: "debit",
          type: "refund",
          // F-082: intent-distinct dedupe (vs the void-refund leg, which is also a debit-refund of
          // the same bet) — matches the already-distinct reverseKey above.
          intent: "restart_refund",
          ref: { refType: "bet", refId: bet.id },
        });
        await this.prisma.bet.update({
          where: { id: bet.id },
          data: { status: "cancelled", settledAt: new Date() },
        });
      } catch (e: any) {
        this.log.error(`restart refund failed for bet ${bet.id}: ${e?.message}`);
      }
    }
    await this.prisma.round.update({
      where: { id: roundId },
      data: { status: "completed", settledAt: new Date() },
    });
  }

  /**
   * F-079 (money — OUTCOME-AWARE stale-extra close). resumeOrRecover resumes the newest open
   * round and must close out any OLDER open round (a "stale extra" — the single-open-round
   * invariant should make this impossible, but a split-brain/anomaly could leave one). Closing
   * it must MIRROR the pre/post-outcome distinction resumeRound/unresumableReason already make,
   * NOT blanket-refund:
   *
   *   - PRE-OUTCOME (waiting / betting): no deterministic result was produced and no money is
   *     owed → REFUND its live bets (closeAndRefundRound). Correct + unchanged.
   *
   *   - POST-OUTCOME (running / crashed / settling): the crash is DETERMINISTIC and already
   *     committed; real money is owed (winners that auto-cashed below the crash keep their pay,
   *     the rest bust). Refunding a not-yet-busted `active` LOSER here (the old behavior) is a
   *     player-favorable GGR leak. Instead we DRIVE SETTLEMENT through the EXACT same idempotent
   *     mechanism a normal completion / a settling-resume uses: reveal the seed (idempotent),
   *     backfill crashedAt if the dead leader never stamped it, then EMIT the `settle` event for
   *     THIS round's id → gateway.onSettle → bets.settleRound(roundId), whose `updateMany where
   *     {roundId, status:'active'}` busts the stranded losers (CAS-on-status) while leaving
   *     already-`cashed_out` winners untouched (so it can NEVER double-pay or claw back a win).
   *     We do NOT author any new money logic here — settleRound is the single, idempotent,
   *     conserving bust path; emitting `settle` is identical to resumeRound's settling branch.
   *     Finally force-mark the round `completed` (it never reached its own enterCompleted). The
   *     emit-then-complete ordering is benign: settleRound busts by {roundId,status:'active'}
   *     regardless of round status, exactly as the settling-resume branch documents.
   *
   * NOTE: this is a stale EXTRA only — it does not become the resumed loop. We deliberately do
   * NOT honor late auto-cashout targets for a stale extra (no live curve, and the honor-pay is
   * the resumed candidate's job): any still-`active` bet on a post-outcome extra simply busts,
   * the conservative (house-favorable, never player-favorable) outcome, which is also exactly
   * what the live loop's crashed→settling gap does for a bet that outlived its cash-out window.
   */
  private async closeStaleExtra(r: { id: string; status: string; seedId: string | null; crashedAt: Date | null }) {
    const postOutcome = r.status === "running" || r.status === "crashed" || r.status === "settling";
    if (!postOutcome) {
      // Pre-outcome (waiting/betting): refund — no result was produced.
      this.log.warn(`resume: stale extra ${r.id} (${r.status}) is pre-outcome → close+refund`);
      await this.closeAndRefundRound(r.id);
      return;
    }
    // Post-outcome: SETTLE (bust stranded active losers, keep paid winners) via the idempotent
    // settle path — never refund a committed-crash loser.
    this.log.warn(`resume: stale extra ${r.id} (${r.status}) is post-outcome → settle (bust stranded losers, keep winners)`);
    if (r.seedId) await this.fairness.revealSeed(r.seedId); // idempotent revealedAt write
    // fairness-L1 backfill (mirrors the crashed-resume branch): stamp crashedAt only if the dead
    // leader died before doing so — idempotent + forensic-only.
    if (r.crashedAt === null) {
      await this.prisma.round.updateMany({ where: { id: r.id, crashedAt: null }, data: { crashedAt: new Date() } });
    }
    // Drive the bust through the SAME idempotent settlement a normal completion uses (gateway
    // onSettle → bets.settleRound(roundId); CAS on status='active'). This does NOT touch
    // this.state, so it is safe to emit for a NON-current round id.
    this.events.emit("settle", { roundId: r.id, crashMultiplier: null });
    // Force-mark completed (the extra never reached its own enterCompleted). settleRound busts by
    // {roundId,status:'active'} regardless of round status, so this ordering is benign.
    await this.prisma.round.update({ where: { id: r.id }, data: { status: "completed", settledAt: new Date() } });
  }

  /**
   * Phase 4.5c.2 — SEAMLESS FAILOVER-RESUME entry point (called from start()).
   *
   * Instead of always close+refunding the in-flight round (the old behavior), a survivor
   * that takes leadership mid-round RESUMES the persisted round and continues the
   * deterministic provably-fair outcome. Returns true if it resumed (start() then does
   * nothing more), false if there was nothing to resume (start() opens a fresh round).
   *
   * Steps (design): (1) clear stale reserving slots first; (2) find OPEN rounds newest-first;
   * (3) older opens are anomalies (violate single-open-round) → close them OUTCOME-AWARE (F-079:
   * post-outcome extras settle, pre-outcome extras refund — closeStaleExtra) + log loudly;
   * (4) validate the newest candidate is resumable, else close+refund it (SAFE FALLBACK) and
   * return false so start() opens fresh; (5/6) hand the clean candidate to resumeRound().
   *
   * The whole thing runs under our authoritative leadership (we just won the lock); every
   * scheduled transition additionally fences via stillLeader(), and resumeRound() guards its
   * own money writes — defense in depth.
   */
  private async resumeOrRecover(): Promise<boolean> {
    // (1) H1: refund/clear stale 'reserving' bets first (pre-debit dust / stranded slots).
    await this.recoverReservingBets();

    // (2) All open rounds, NEWEST first. The healthy invariant is exactly one (or zero).
    const open = await this.prisma.round.findMany({
      where: { status: { in: OPEN_PHASES as string[] } },
      orderBy: { createdAt: "desc" },
    });
    if (open.length === 0) return false; // clean DB → start() opens a fresh round

    // (3) Any round OLDER than the newest open one violates the single-open-round invariant
    // (two simultaneously-open rounds should be impossible). Close out every stale extra and
    // log loudly — never try to resume more than one loop. F-079 (money — outcome-aware):
    // closing a stale extra must MIRROR resumeRound's pre/post-outcome distinction, NOT blanket-
    // refund. A pre-outcome extra (waiting/betting) produced no result and owes no money → REFUND
    // its live bets (closeAndRefundRound). A post-outcome extra (running/crashed/settling) has a
    // DETERMINISTIC crash already committed and real money owed on it → drive SETTLEMENT (bust the
    // stranded active losers via the same idempotent settle path a normal completion uses; KEEP
    // already-paid winners) instead of refunding a not-yet-busted loser (the GGR leak this fixes).
    const [candidate, ...stale] = open;
    if (stale.length > 0) {
      this.log.error(
        `resume: found ${open.length} OPEN rounds (expected 1) — single-open-round invariant violated; ` +
          `closing ${stale.length} stale extra(s) outcome-aware, resuming only the newest (${candidate.id})`,
      );
      for (const r of stale) await this.closeStaleExtra(r);
    }

    // (4) Validate the candidate is resumable. A partial/corrupt row (missing seed,
    // non-positive crash, a running/crashed/settling round with no startedAt or no
    // phaseEndsAt) cannot be deterministically resumed → close+refund it (SAFE FALLBACK)
    // and return false so start() opens fresh.
    const reason = this.unresumableReason(candidate);
    if (reason) {
      this.log.warn(`resume: candidate round ${candidate.id} (${candidate.status}) NOT resumable (${reason}) → close+refund + fresh start`);
      await this.closeAndRefundRound(candidate.id);
      return false;
    }

    // (5/6) Clean candidate → resume the loop from its persisted phase.
    await this.resumeRound(candidate);
    return true;
  }

  /**
   * Validate that a persisted open round can be deterministically resumed. Returns null
   * when resumable, else a human reason for the fallback log. The crash time + the running
   * multiplier are derived from startedAt + crashPoint + GROWTH, so those MUST be present
   * once the round has left betting; phaseEndsAt anchors every other phase's countdown.
   */
  private unresumableReason(r: { status: string; seedId: string | null; crashPoint: Prisma.Decimal; startedAt: Date | null; phaseEndsAt: Date | null }): string | null {
    if (!r.seedId) return "missing seedId";
    const crash = Number(r.crashPoint);
    // crashPoint is ALWAYS >= 1.00 by construction (the crash formula). The ONLY genuinely
    // corrupt values are < 1 or NaN — reject those. A crashPoint of EXACTLY 1.00 is the
    // deterministic instant-bust outcome (~3-4% of rounds), NOT corruption: admitting it
    // uniformly for every phase makes resumeRound bust all bets (house keeps the stake), the
    // committed outcome. Refunding it (the old `!(crash > 1)` guard) was a player-favorable
    // conservation deviation (M-1). NaN is still rejected: `NaN >= 1` is false → `!(false)` = true.
    if (!(crash >= 1)) return `corrupt crashPoint ${String(r.crashPoint)} (<1 or NaN)`;
    if (r.phaseEndsAt === null) return "missing phaseEndsAt";
    // Staleness bound — applies to waiting/betting ONLY. These phases have NO deterministic
    // outcome yet (no crash has happened, no money is owed): the round is just counting down
    // to its next transition against a live multiplier curve / open betting window. If that
    // deadline passed more than RESUME_MAX_STALENESS_MS ago, the process was DOWN far longer
    // than the failover budget — there is no live curve to climb back into and clients have
    // moved on, so this is UNRESUMABLE → close+refund + fresh start (betting refunds the live
    // bets that can no longer fairly run; waiting has none, so it just starts fresh). running/
    // crashed/settling are DELIBERATELY excluded: their outcome is already deterministic and
    // real money is owed on it, so they are HONORED + FINISHED regardless of age (see
    // resumeRound) — never staleness-rejected.
    if (r.status === "waiting" || r.status === "betting") {
      const staleBy = Date.now() - r.phaseEndsAt.getTime();
      if (staleBy > RESUME_MAX_STALENESS_MS) {
        return `ancient ${r.status} (stale >${RESUME_MAX_STALENESS_MS}ms, by ${staleBy}ms)`;
      }
    }
    // running/crashed/settling all imply the round already started → startedAt anchors the
    // crash time. waiting/betting legitimately have no startedAt yet.
    if ((r.status === "running" || r.status === "crashed" || r.status === "settling") && r.startedAt === null) {
      return `status ${r.status} with no startedAt`;
    }
    return null;
  }

  /**
   * Phase 4.5c.2 — resume the engine loop on a validated persisted round, continuing the
   * DETERMINISTIC outcome from the correct phase. Rebuilds this.state from the DB row
   * (incl. the server-only crashPoint), mirrors + re-emits so clients/followers re-sync,
   * then re-arms the next transition. Every scheduled transition fences via stillLeader();
   * the one money-bearing branch here (a crash that elapsed during the failover gap) is
   * additionally guarded by an explicit stillLeader() check before it pays/settles.
   *
   * crashPoint is rebuilt into this.state (the leader needs it for the post-crash reveal +
   * the authoritative cashOut gate) but is NEVER published — mirror() strips it, exactly as
   * on the normal path.
   */
  private async resumeRound(r: { id: string; seedId: string; status: string; crashPoint: Prisma.Decimal; startedAt: Date | null; phaseEndsAt: Date | null }) {
    const now = Date.now();
    const phase = r.status as Phase;
    const crashPoint = Number(r.crashPoint);
    const startedAt = r.startedAt ? r.startedAt.getTime() : null;
    const phaseEndsAt = r.phaseEndsAt!.getTime(); // validated non-null for every resumable phase
    this.state = { roundId: r.id, seedId: r.seedId, phase, phaseEndsAt, startedAt, crashPoint };
    // Re-publish the public state so followers' caches + clients immediately re-sync to the
    // resumed round (NO crashPoint — mirror() strips it).
    await this.mirror();
    this.emitPhase(phase);
    this.log.warn(`resume: re-attached round ${r.id} in phase '${phase}' (phaseEndsAt in ${phaseEndsAt - now}ms)`);

    switch (phase) {
      case "waiting":
        // No bets exist yet (placeBet gates on 'betting'). Just continue the countdown.
        this.schedule(Math.max(0, phaseEndsAt - now), () => this.safe(() => this.enterBetting(), "betting"));
        return;

      case "betting":
        // Bets are active (reserved/debited) but the round hasn't started climbing. Continue
        // the betting window; if it already elapsed during the gap, enterRunning() fires
        // immediately (schedule clamps to >=0) and the round starts — deterministic, no money
        // moved yet (cash-outs only open once running).
        this.schedule(Math.max(0, phaseEndsAt - now), () => this.safe(() => this.enterRunning(), "running"));
        return;

      case "running": {
        // Crash time is fully deterministic from the persisted startedAt + crashPoint.
        const crashTime = startedAt! + Math.max(0, Math.log(crashPoint) / GROWTH);
        if (now < crashTime) {
          // SEAMLESS CLIMB: the round is still mid-flight. this.state.phase is already
          // 'running', so onTick resumes ticking + honoring autos and manual cash-outs work
          // (4.5c.1 re-reads the authoritative Round). Just re-arm the crash at its real time.
          this.schedule(crashTime - now, () => this.safe(() => this.enterCrashed(), "crashed"));
          return;
        }
        // CRASH ELAPSED DURING THE GAP. We must HONOR the deterministic outcome — pay every
        // bet whose autoCashout target is BELOW crashPoint at its target — rather than bust
        // winners just because the survivor took over a moment late. This is money-bearing,
        // so do it explicitly and deterministically (NOT via the onTick(120ms)↔schedule(0)
        // race): with this.state.phase='running' and DB status still 'running', the driver's
        // evaluateAutoCashouts(crashPoint) pays each due bet via cashOut(target), whose
        // `mult < crashPoint` gate makes target>=crashPoint correctly BUST. AWAIT it, THEN
        // enterCrashed() reveals + busts the remainder + drives settlement. Honored regardless
        // of staleness — real money is owed on a crash that already happened.
        this.log.warn(`resume: round ${r.id} crash elapsed during the gap (by ${now - crashTime}ms) — honoring due auto-cashouts then crashing`);
        // Defense in depth: we ARE the lock-holder (just acquired), so this won't trip; but
        // never move money on a stale leader. Fence before the honor-pay.
        if (!(await this.stillLeader("resumeRound:running"))) return;
        if (this.autoCashoutDriver) {
          await this.autoCashoutDriver(crashPoint); // pays target<crashPoint at target; target>=crashPoint busts
        } else {
          // Driver not registered (shouldn't happen — afterInit precedes any start()). The
          // periodic onTick will still honor the due autos before we cross into 'crashed';
          // log so the non-deterministic fallback is visible rather than silent.
          this.log.warn(`resume: no auto-cashout driver registered — relying on onTick to honor autos for round ${r.id}`);
        }
        await this.enterCrashed();
        return;
      }

      case "crashed":
        // The crash already happened. Ensure the seed is revealed (revealSeed is idempotent —
        // an unconditional revealedAt write, safe to call twice), re-emit crash, then continue
        // into settling. Active bets surviving into the crashed→settling gap are correctly
        // busted by settleRound (4.5c.1 blocks any above-crash pay since status != running).
        await this.fairness.revealSeed(this.state.seedId);
        // fairness-L1 backfill: if the dead leader died in the ~1-statement window between
        // writing status='crashed' and stamping crashedAt, the row can keep crashedAt=null
        // forever (forensic-only — no fairness math reads it — but audit-untidy). Backfill it
        // ONLY when still null, so it's idempotent and cheap (a no-op once stamped).
        await this.prisma.round.updateMany({
          where: { id: r.id, crashedAt: null },
          data: { crashedAt: new Date() },
        });
        await this.mirror();
        this.events.emit("crash", { roundId: this.state.roundId, crashMultiplier: this.state.crashPoint });
        this.schedule(Math.max(0, phaseEndsAt - now), () => this.safe(() => this.enterSettling(), "settling"));
        return;

      case "settling": {
        // H-1: the dead leader wrote status='settling' but may have died BEFORE/DURING
        // settleRound's updateMany that busts the losing bets. We are NOT calling enterSettling
        // here (it would re-do the status='settling' write + reschedule from a fresh deadline) —
        // so we must DRIVE settlement ourselves, exactly like the forward path does: emit the
        // 'settle' event now (→ gateway.onSettle → bets.settleRound), then schedule completion
        // at the PERSISTED deadline. settleRound is idempotent (CAS on status='active'): if the
        // dead leader already busted the bets it's a no-op; if it didn't, this finally busts the
        // stranded losing bets. WITHOUT this emit they would be stranded status='active' inside a
        // 'completed' round FOREVER (future boots scan only OPEN_PHASES, which excludes
        // 'completed'). Emitting settle FIRST makes it deterministic; even if enterCompleted
        // (status='completed') somehow raced ahead, settleRound busts by {roundId,status:active}
        // REGARDLESS of round status, so the ordering race is benign either way.
        this.events.emit("settle", { roundId: this.state.roundId, crashMultiplier: this.state.crashPoint });
        this.schedule(Math.max(0, phaseEndsAt - now), () => this.safe(() => this.enterCompleted(), "completed"));
        return;
      }

      case "completed":
        // UNREACHABLE defensive belt (M2): 'completed' is terminal and is NEVER an OPEN_PHASES
        // candidate, so resumeOrRecover never hands a completed round here. If we somehow DO
        // land here it's a real anomaly — make it LOUD (error, not warn). We must NOT bare-return
        // (that would leave NO loop scheduled = a silent stall); instead open a fresh round so
        // the engine always keeps running.
        this.log.error(`resume: UNREACHABLE terminal phase 'completed' for round ${r.id} — defensive fresh-round restart`);
        await this.enterWaiting();
        return;

      default: {
        // COMPILE-TIME exhaustiveness sink: every Phase is handled above, so `phase` here is
        // `never`. This stops compiling if a new Phase is added without a case — but it must
        // NOT stall at runtime, so we still log loudly and open a fresh round (the assignment
        // is type-only; the recovery below always runs).
        const _exhaustive: never = phase;
        this.log.error(`resume: UNREACHABLE phase '${String(_exhaustive)}' for round ${r.id} — defensive fresh-round restart`);
        await this.enterWaiting();
        return;
      }
    }
  }

  /**
   * Recovery for stranded reservation slots ('reserving') and any left mid-reversal
   * ('cancelling'). A slot whose debit actually applied (money moved but the flip to
   * 'active' never completed) is REFUNDED; one with no ledger debit moved no money —
   * just drop it. The LEDGER (deterministic debit key) is the source of truth, so this
   * is robust even if debitTxId was never stamped. Operator charges are reversed via the
   * idempotent wallet$.rollback (no-op internal). Idempotent refund key, so a double pass
   * can't double-refund. Runs regardless of round status.
   *
   * Claim-first (audit Low-1): each slot is atomically claimed 'reserving' → 'cancelling'
   * (a recoverable in-progress state, like payout_pending) BEFORE any money is reversed.
   * A slot that concurrently flipped to 'active' (a real activation — placeBet's flip is
   * ALSO a CAS on 'reserving') loses the claim and is NEVER reversed, so recovery is
   * correct INDEPENDENT of the age-gate timing margin. A crash/failure mid-reversal
   * leaves the row 'cancelling', which a later pass re-selects and re-reverses
   * (idempotent) — never stranding an owed refund.
   *
   * @param olderThanMs only recover slots older than this (by createdAt). 0 (the
   *   default, used at boot) recovers ALL slots — safe there because no placeBet is in
   *   flight before the engine starts. The periodic gateway sweep passes a threshold
   *   (RESERVING_STALE_SEC) so a placeBet legitimately mid-flight is never swept. Returns
   *   how many slots were reversed.
   */
  async recoverReservingBets(olderThanMs = 0): Promise<number> {
    const where: Prisma.BetWhereInput = { status: { in: ["reserving", "cancelling"] } };
    if (olderThanMs > 0) where.createdAt = { lt: new Date(Date.now() - olderThanMs) };
    const slots = await this.prisma.bet.findMany({ where });
    if (slots.length === 0) return 0;
    this.log.warn(
      `recovering ${slots.length} ${olderThanMs > 0 ? `stale (>${Math.round(olderThanMs / 1000)}s) ` : ""}'reserving'/'cancelling' slot(s)`,
    );
    let recovered = 0;
    for (const bet of slots) {
      const debitKey = `bet:${bet.roundId}:${bet.userId}:${bet.panel}:debit`;
      // CLAIM atomically: 'reserving' → 'cancelling' only if STILL reserving. A slot that
      // concurrently flipped to 'active' (placeBet's flip is ALSO a CAS on 'reserving')
      // loses here and is left untouched — recovery never reverses a live bet (audit
      // Low-1). A row already 'cancelling' was claimed by a prior pass that crashed/failed
      // mid-reversal → fall through and re-attempt the idempotent reversal.
      if (bet.status === "reserving") {
        const claim = await this.prisma.bet.updateMany({
          where: { id: bet.id, status: "reserving" },
          data: { status: "cancelling" },
        });
        if (claim.count === 0) continue; // raced to 'active' — leave the live bet alone
      }
      try {
        // Reverse any OPERATOR-side charge (idempotent; no-op internal / if never applied).
        await this.wallet$.rollback(bet.walletId, debitKey, { refType: "bet", refId: bet.id });
        // Internal ledger: if the debit actually applied, refund it (idempotent restart
        // key, so a double pass can't double-pay), then finalize 'cancelling' → 'cancelled'.
        const debited = await this.prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: debitKey } });
        if (debited) {
          await this.wallet$.credit(bet.walletId, bet.amount, "refund", `bet:${bet.id}:restart_refund`, {
            refType: "bet",
            refId: bet.id,
          });
          await this.prisma.bet.update({ where: { id: bet.id }, data: { status: "cancelled", settledAt: new Date() } });
        } else {
          // No internal debit moved money — drop the now-claimed slot.
          await this.prisma.bet.delete({ where: { id: bet.id } }).catch(() => {});
        }
        recovered++;
      } catch (e: any) {
        // Reversal failed AFTER claiming — leave the row 'cancelling' so a later pass
        // (sweep or boot) re-attempts the idempotent reversal; never strand an owed refund.
        this.log.error(`reserving recovery failed for bet ${bet.id}: ${e?.message} — left 'cancelling' for retry`);
      }
    }
    return recovered;
  }

  /**
   * F-083: finalize bets stranded `active` on a force-`completed`, pre-outcome (refund-all) round.
   * This can happen ONLY if closeAndRefundRound's reverse() threw on its first try: the round is
   * force-`completed` but the bet row stays `active`, and neither recoverReservingBets
   * (reserving/cancelling only) nor recoverInterruptedRounds (OPEN rounds only) rescans it. The
   * owed refund is durable (operator mode: the wallet_rollbacks outbox re-driven by drainPending;
   * internal/demo mode: re-posted idempotently here). We target ONLY `completed` + `crashedAt:null`
   * — the refund-all terminal: a normally-settled round always passes through `crashed` (crashedAt
   * stamped) before `completed`, so an outcome-bearing round's winners/losers are NEVER touched here
   * — plus an age gate so we never race a live close. Re-run the SAME idempotent restart-refund (no
   * double-pay: keyed on `bet:{id}:restart_refund` + the operator originalKey) then CAS-finalize
   * `active` → `cancelled`. Leader-gated by the caller (shared DB + money).
   */
  async recoverStrandedActiveBets(olderThanMs = 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stranded = await this.prisma.bet.findMany({
      where: {
        status: "active",
        round: { status: "completed", crashedAt: null, settledAt: { lt: cutoff } },
      },
      select: { id: true, walletId: true, amount: true, roundId: true, userId: true, panel: true },
      take: 100,
    });
    if (stranded.length === 0) return 0;
    this.log.warn(
      `F-083: finalizing ${stranded.length} bet(s) stranded 'active' on a refund-all (completed/pre-outcome) round`,
    );
    let healed = 0;
    for (const bet of stranded) {
      try {
        await this.wallet$.reverse(bet.walletId, {
          originalKey: `bet:${bet.roundId}:${bet.userId}:${bet.panel}:debit`,
          reverseKey: `bet:${bet.id}:restart_refund`,
          amount: bet.amount,
          originalDirection: "debit",
          type: "refund",
          intent: "restart_refund", // F-082: matches closeAndRefundRound's intent-distinct dedupe
          ref: { refType: "bet", refId: bet.id },
        });
        // CAS on status so a concurrent path that already finalized this bet wins (no double work).
        const flip = await this.prisma.bet.updateMany({
          where: { id: bet.id, status: "active" },
          data: { status: "cancelled", settledAt: new Date() },
        });
        if (flip.count > 0) healed++;
      } catch (e: any) {
        this.log.error(
          `F-083 stranded-active finalize failed for bet ${bet.id}: ${e?.message} — left for the next sweep`,
        );
      }
    }
    return healed;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.clearDeadman(); // F-048c: a follower (or a stopped node) must not run the leader deadman
  }

  // ---- F-048c round-liveness deadman (the backstop if the per-phase self-heal itself wedges) ----
  private armDeadman() {
    this.clearDeadman();
    this.deadmanTimer = setInterval(() => void this.deadmanCheck(), deadmanCheckMs());
    this.deadmanTimer.unref?.(); // never keep the event loop alive solely for this (clean exit)
  }
  private clearDeadman() {
    if (this.deadmanTimer) {
      clearInterval(this.deadmanTimer);
      this.deadmanTimer = null;
    }
  }

  /** True iff this node is the engine leader (consumed by /health/live, F-051). */
  isEngineLeader(): boolean {
    return this.election.isLeader();
  }
  /** ms since the last COMPLETED round (consumed by /health/live + the deadman). */
  msSinceLastRound(): number {
    return Date.now() - this.lastRoundAt;
  }

  /**
   * F-048c — periodic round-liveness check. If we are the LEADER and no round has completed
   * within DEADMAN_MS, the loop is wedged in a way the per-phase deadline (F-048a) did not
   * self-heal. We make it LOUD (error log + the engine_stall error metric + Sentry) and then
   * VOLUNTARILY step down — NOT a new settlement/teardown path, just a clean advisory-lock
   * release via election.stepDown(), so a healthy follower acquires and takes over through the
   * PROVEN, money-safe failover-resume (resumeOrRecover, commit 163d459). The follower's
   * resumeRound() owns the in-flight round; every money write there is idempotent + fence-
   * guarded, so a takeover cannot double-settle. On a SINGLE node the stepped-down node simply
   * re-acquires the now-free lock on its next poll and start()s fresh — self-healing either way.
   * Re-entrancy + leadership guarded so it fires once per stall.
   */
  private async deadmanCheck() {
    if (this.steppingDown || !this.election.isLeader()) return;
    const deadline = deadmanMs();
    const stalledMs = this.msSinceLastRound();
    if (stalledMs <= deadline) return;
    this.steppingDown = true;
    const msg = `engine STALL: no round completed in ${stalledMs}ms (> ${deadline}ms deadman) — self-demoting for failover`;
    this.log.error(msg);
    this.metrics.recordError("engine_stall"); // makes ErrorSpike + a dedicated alert fire
    captureException(new Error(msg), { where: "engine_stall", stalledMs, phase: this.state?.phase ?? null });
    try {
      // Clean lock-release via the SAME demotion path a dead heartbeat uses (fires leader-lost
      // → our stop()). A follower then resumes; if we are single-node we re-acquire next poll.
      await this.election.stepDown("engine-stall-deadman");
    } catch (e: any) {
      // stepDown is best-effort; if it somehow throws, fall back to a local stop+restart so a
      // single node still recovers (re-acquire on next poll re-runs start()).
      this.log.error(`deadman step-down failed (${e?.message}) — local stop fallback`);
      this.stop();
    }
  }

  // ---- public reads (no secret leakage) ----
  // Leadership-aware (design §3): the LEADER reads its authoritative in-memory `this.state`
  // (unchanged — it holds crashPoint for the post-crash reveal). A FOLLOWER has no engine
  // loop, so it reads the PublicRoundCache (leader-published public state, NO crashPoint)
  // and computes the running multiplier locally. This is what makes a manual cash-out on a
  // follower return the correct multiplier instead of 1.0 — with ZERO change to cashOut.
  currentMultiplier(): number {
    if (!this.election.isLeader()) return this.cache.currentMultiplier();
    const s = this.state;
    if (!s) return 1.0;
    if (s.phase === "crashed" || s.phase === "settling" || s.phase === "completed") {
      return s.crashPoint; // revealed after the crash
    }
    if (s.phase === "running" && s.startedAt) {
      const m = Math.exp(GROWTH * (Date.now() - s.startedAt));
      return Math.max(1.0, Math.floor(m * 100) / 100);
    }
    return 1.0;
  }

  getPublicState(): PublicRoundState | null {
    if (!this.election.isLeader()) return this.cache.getPublicState();
    const s = this.state;
    if (!s) return null;
    return {
      roundId: s.roundId,
      phase: s.phase,
      phaseEndsAt: s.phaseEndsAt,
      multiplier: this.currentMultiplier(),
      serverTime: Date.now(),
    };
  }

  // ---- loop ----
  private schedule(ms: number, fn: () => void) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.running) fn();
    }, Math.max(0, ms));
  }

  /**
   * Publish the PUBLIC round state for followers (design §3). Writes the `round:current`
   * snapshot (late joiners / a node that boots mid-round) AND publishes on the
   * `vaultrun:round` pub/sub channel (live follower updates). The payload is the existing
   * public shape (NO crashPoint) PLUS `startedAt` + `seedId` — `startedAt` so a follower
   * can recompute the running multiplier locally; `seedId` for the (4.5c) resume anchor.
   * `crashPoint` is NEVER published — same guarantee as the original mirror().
   */
  private async mirror() {
    if (!this.state) return;
    const base = this.getPublicState();
    if (!base) return;
    const payload: PublishedRoundState = { ...base, startedAt: this.state.startedAt, seedId: this.state.seedId };
    const json = JSON.stringify(payload);
    try {
      await this.redis.client.set(ROUND_SNAPSHOT_KEY, json, "EX", 120);
      await this.redis.client.publish(ROUND_CHANNEL, json);
    } catch {
      /* redis optional for a single instance — the leader path is unaffected */
    }
  }

  /**
   * Fence the engine's authored writes (design §2 Belt B). Called at the TOP of every
   * phase transition: if we are no longer the authoritative leader (a second node bumped
   * the fence past ours, or our lock died), self-demote BEFORE any DB write so a stale
   * leader can never touch money/round state. Returns true to proceed, false to abort.
   */
  private async stillLeader(where: string): Promise<boolean> {
    if (await this.election.assertStillLeader()) return true;
    this.log.warn(`fence check failed at ${where} — self-demoting, aborting the transition`);
    this.stop();
    return false;
  }

  private emitPhase(phase: Phase) {
    this.events.emit("phase", this.getPublicState());
    this.events.emit(phase, this.getPublicState());
  }

  private async enterWaiting() {
    // Fence FIRST — a stale leader self-demotes before allocating a seed or minting a round.
    if (!(await this.stillLeader("enterWaiting"))) return;
    // Best-effort fairness upkeep (arm pending epochs, pre-commit the next epoch)
    // — fire-and-forget so it never delays the round; it guards its own errors.
    void this.fairness.maintain();
    // Allocate the seed + compute the (hidden) crash, then open a fresh round.
    const seed = await this.fairness.allocateSeed();
    if (!seed) {
      // No servable epoch yet — real-money is waiting for the committed block salt to
      // resolve (audit M6). Never open a round on a grindable random salt; retry shortly
      // (the maintain() above arms the block epoch once its block finalizes). Not an error.
      this.log.warn("fairness: awaiting committed block salt before opening a round (FAIRNESS_REQUIRE_BLOCK_SALT)");
      this.schedule(1500, () => this.safe(() => this.enterWaiting(), "waiting"));
      return;
    }
    const crashPoint = this.fairness.crashForSeed(seed);
    const phaseEndsAt = Date.now() + PHASE_MS.waiting;
    let round;
    try {
      round = await this.prisma.round.create({
        data: {
          seedId: seed.id,
          nonce: BigInt(seed.chainIndex),
          crashPoint,
          status: "waiting" as Phase,
          bettingOpensAt: new Date(phaseEndsAt),
          phaseEndsAt: new Date(phaseEndsAt),
        },
      });
    } catch (e) {
      // Belt A (design §2): @@unique([seedId]). A P2002 here means ANOTHER leader already
      // minted a round on this seed — i.e. WE are not (or no longer) the authoritative
      // leader. Treat it as a lost-leadership signal: stop and do NOT retry into safe()
      // (no busy-loop, no second seed allocation). The real leader owns the loop.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        this.log.warn(`round.create hit P2002 on seed ${seed.id} — another leader minted it; self-demoting (lost leadership)`);
        this.stop();
        return;
      }
      throw e; // any other DB error → safe() backs off + retries
    }
    this.state = {
      roundId: round.id,
      seedId: seed.id,
      phase: "waiting",
      phaseEndsAt,
      startedAt: null,
      crashPoint,
    };
    await this.mirror();
    this.emitPhase("waiting");
    this.schedule(PHASE_MS.waiting, () => this.safe(() => this.enterBetting(), "betting"));
  }

  private async enterBetting() {
    if (!this.state) return;
    if (!(await this.stillLeader("enterBetting"))) return;
    this.state.phase = "betting";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.betting;
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "betting", phaseEndsAt: new Date(this.state.phaseEndsAt) },
    });
    await this.mirror();
    this.emitPhase("betting");
    this.schedule(PHASE_MS.betting, () => this.safe(() => this.enterRunning(), "running"));
  }

  private async enterRunning() {
    if (!this.state) return;
    if (!(await this.stillLeader("enterRunning"))) return;
    const now = Date.now();
    this.state.phase = "running";
    this.state.startedAt = now;
    this.state.phaseEndsAt = now + 60_000; // upper bound; crash fires earlier
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "running", startedAt: new Date(now), phaseEndsAt: new Date(this.state.phaseEndsAt) },
    });
    await this.mirror();
    this.emitPhase("running");

    // Time until the precomputed crash multiplier is reached.
    const crashDelay = Math.max(0, Math.log(this.state.crashPoint) / GROWTH);
    this.schedule(crashDelay, () => this.safe(() => this.enterCrashed(), "crashed"));
  }

  private async enterCrashed() {
    if (!this.state) return;
    if (!(await this.stillLeader("enterCrashed"))) return;
    // F-080 (fairness — zombie-state defense-in-depth): CAPTURE this round's identifiers into
    // LOCALS at entry. The reveal/update below is awaited; under H5's per-phase deadline a HUNG
    // enterCrashed can resolve LATE (a "zombie") long after `this.state` has been re-pointed at a
    // FRESH round by a recovered loop. Reading `this.state.roundId|seedId|crashPoint` AFTER an
    // await would then reveal/crash the SUCCESSOR round's ids. Operating on the entry-captured
    // locals makes that impossible by construction — a late zombie can only ever act on the round
    // it was started for. On the normal path the locals equal this.state at entry, so behavior is
    // unchanged. (crashPoint is the reveal value, never published — mirror() strips it.)
    const { roundId, seedId, crashPoint } = this.state;
    this.state.phase = "crashed";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.crashed;
    await this.prisma.round.update({
      where: { id: roundId },
      data: { status: "crashed", crashedAt: new Date(), phaseEndsAt: new Date(this.state.phaseEndsAt) },
    });
    await this.fairness.revealSeed(seedId); // make the proof public
    await this.mirror();
    this.events.emit("crash", { roundId, crashMultiplier: crashPoint });
    this.emitPhase("crashed");
    this.schedule(PHASE_MS.crashed, () => this.safe(() => this.enterSettling(), "settling"));
  }

  private async enterSettling() {
    if (!this.state) return;
    if (!(await this.stillLeader("enterSettling"))) return;
    this.state.phase = "settling";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.settling;
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "settling", phaseEndsAt: new Date(this.state.phaseEndsAt) },
    });
    await this.mirror();
    // M6 will settle bets here (engine ↔ ledger). For M4 this is a no-op hook.
    this.events.emit("settle", { roundId: this.state.roundId, crashMultiplier: this.state.crashPoint });
    this.emitPhase("settling");
    this.schedule(PHASE_MS.settling, () => this.safe(() => this.enterCompleted(), "completed"));
  }

  private async enterCompleted() {
    if (!this.state) return;
    if (!(await this.stillLeader("enterCompleted"))) return;
    this.state.phase = "completed";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.completed;
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "completed", settledAt: new Date(), phaseEndsAt: new Date(this.state.phaseEndsAt) },
    });
    await this.mirror();
    this.lastRoundAt = Date.now(); // F-048c: a round just COMPLETED → the loop is alive
    this.metrics.recordRound(); // vaultrun_rounds_total + the F-050 last-round timestamp gauge
    this.events.emit("settled", { roundId: this.state.roundId });
    this.emitPhase("completed");
    this.schedule(PHASE_MS.completed, () => this.safe(() => this.enterWaiting(), "waiting"));
  }

  /**
   * Run a phase transition, logging + retrying on failure so the loop survives.
   *
   * F-048a: the awaited phase work is RACED against a per-phase deadline that REJECTS. A
   * HUNG transition (a never-settling await — the silent-stall root cause) therefore rejects
   * into the catch below and the loop reschedules a fresh enterWaiting() instead of stalling
   * forever. The reject does not abandon the slow fn() — it keeps running and a late
   * resolve/reject is harmlessly consumed (no unhandled rejection); the timer is always cleared.
   *
   * F-049: on ANY failure we now also record the `phase_transition` error metric + capture to
   * Sentry (labelled by phase), so a crash-/hang-looping engine actually trips ErrorSpike +
   * surfaces in Sentry — previously the catch only log.error'd and was invisible to alerting.
   */
  private safe(fn: () => Promise<void>, phase: Phase | "unknown" = "unknown") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineMs = phaseDeadlineMs();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`phase '${phase}' exceeded ${deadlineMs}ms deadline (hung transition)`)),
        deadlineMs,
      );
    });
    Promise.race([fn(), deadline])
      .catch((e) => {
        this.log.error(`phase transition '${phase}' failed: ${e?.message}`);
        this.metrics.recordError("phase_transition"); // F-049: surfaces to ErrorSpike
        captureException(e, { where: "phase_transition", phase }); // F-049
        // back off briefly then try to recover by starting a fresh round. enterWaiting()
        // re-fences via stillLeader() (a stale leader self-demotes) and allocates a FRESH seed
        // idempotently — no fairness deviation.
        this.schedule(1500, () => this.safe(() => this.enterWaiting(), "waiting"));
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }
}
