import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { FairnessService } from "../fairness/fairness.service";
import { WALLET_PROVIDER, type WalletProvider } from "../wallet/wallet-provider";
import { MetricsService } from "../metrics/metrics.service";
import { ElectionService } from "../ha/election.service";
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

@Injectable()
export class GameEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(GameEngineService.name);
  /** phase / tick / crash / settled events for the WS gateway (M5). */
  readonly events = new EventEmitter();

  private state: EngineState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

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
      this.start().catch((e) => this.log.error(`start failed: ${e?.message}`));
    });
    this.election.events.on("leader-lost", () => {
      this.log.warn("lost engine leadership → stopping the round loop");
      this.stop();
    });
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
    await this.fairness.ensureChain();
    await this.recoverInterruptedRounds(); // close any round left hanging by a restart
    this.log.log("Game engine started");
    await this.enterWaiting();
  }

  /**
   * Crash-safe restart: a round left in betting/running/crashed/settling when the
   * process died is "zombie" — the in-memory loop is gone but the DB row + its
   * bets are still open. On boot we close every such round and refund its
   * still-active bets (idempotent `bet:{id}:restart_refund`, so a double boot
   * can't double-pay). New rounds only start after this.
   */
  private async recoverInterruptedRounds() {
    // H1: refund/clear stale 'reserving' bets first (regardless of round status).
    await this.recoverReservingBets();
    const OPEN: Phase[] = ["waiting", "betting", "running", "crashed", "settling"];
    const stuck = await this.prisma.round.findMany({
      where: { status: { in: OPEN as string[] } },
      select: { id: true },
    });
    if (stuck.length === 0) return;
    this.log.warn(`recovering ${stuck.length} interrupted round(s) from a restart`);

    for (const r of stuck) {
      const activeBets = await this.prisma.bet.findMany({
        where: { roundId: r.id, status: "active" },
      });
      for (const bet of activeBets) {
        try {
          await this.wallet$.credit(bet.walletId, bet.amount, "refund", `bet:${bet.id}:restart_refund`, {
            refType: "bet",
            refId: bet.id,
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
        where: { id: r.id },
        data: { status: "completed", settledAt: new Date() },
      });
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

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
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
      this.schedule(1500, () => this.safe(() => this.enterWaiting()));
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
    this.schedule(PHASE_MS.waiting, () => this.safe(() => this.enterBetting()));
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
    this.schedule(PHASE_MS.betting, () => this.safe(() => this.enterRunning()));
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
    this.schedule(crashDelay, () => this.safe(() => this.enterCrashed()));
  }

  private async enterCrashed() {
    if (!this.state) return;
    if (!(await this.stillLeader("enterCrashed"))) return;
    this.state.phase = "crashed";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.crashed;
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "crashed", crashedAt: new Date(), phaseEndsAt: new Date(this.state.phaseEndsAt) },
    });
    await this.fairness.revealSeed(this.state.seedId); // make the proof public
    await this.mirror();
    this.events.emit("crash", { roundId: this.state.roundId, crashMultiplier: this.state.crashPoint });
    this.emitPhase("crashed");
    this.schedule(PHASE_MS.crashed, () => this.safe(() => this.enterSettling()));
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
    this.schedule(PHASE_MS.settling, () => this.safe(() => this.enterCompleted()));
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
    this.metrics.recordRound(); // metrics-only: vaultrun_rounds_total (Phase 4.4)
    this.events.emit("settled", { roundId: this.state.roundId });
    this.emitPhase("completed");
    this.schedule(PHASE_MS.completed, () => this.safe(() => this.enterWaiting()));
  }

  /** Run a phase transition, logging + retrying on failure so the loop survives. */
  private safe(fn: () => Promise<void>) {
    fn().catch((e) => {
      this.log.error(`phase transition failed: ${e?.message}`);
      // back off briefly then try to recover by starting a fresh round
      this.schedule(1500, () => this.safe(() => this.enterWaiting()));
    });
  }
}
