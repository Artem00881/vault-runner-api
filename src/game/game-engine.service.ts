import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { FairnessService } from "../fairness/fairness.service";
import { WALLET_PROVIDER, type WalletProvider } from "../wallet/wallet-provider";

export type Phase = "waiting" | "betting" | "running" | "crashed" | "settling" | "completed";

export const PHASE_MS = {
  waiting: 3000,
  betting: 5000,
  crashed: 2500,
  settling: 500,
  completed: 600,
} as const;

/** multiplier(t) = e^(GROWTH * elapsedMs). Tunes pacing only; not fairness. */
export const GROWTH = 0.00012;

interface EngineState {
  roundId: string;
  seedId: string;
  phase: Phase;
  phaseEndsAt: number;
  startedAt: number | null;
  crashPoint: number; // SECRET — never exposed before the crash
}

export interface PublicRoundState {
  roundId: string;
  phase: Phase;
  phaseEndsAt: number;
  multiplier: number;
  serverTime: number;
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
  ) {}

  onModuleInit() {
    if (process.env.GAME_AUTOSTART !== "false") {
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

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  // ---- public reads (no secret leakage) ----
  currentMultiplier(): number {
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

  private async mirror() {
    if (!this.state) return;
    const pub = this.getPublicState();
    try {
      await this.redis.client.set("round:current", JSON.stringify(pub), "EX", 120);
    } catch {
      /* redis optional for single instance */
    }
  }

  private emitPhase(phase: Phase) {
    this.events.emit("phase", this.getPublicState());
    this.events.emit(phase, this.getPublicState());
  }

  private async enterWaiting() {
    // Best-effort fairness upkeep (arm pending epochs, pre-commit the next epoch)
    // — fire-and-forget so it never delays the round; it guards its own errors.
    void this.fairness.maintain();
    // Allocate the seed + compute the (hidden) crash, then open a fresh round.
    const seed = await this.fairness.allocateSeed();
    const crashPoint = this.fairness.crashForSeed(seed);
    const round = await this.prisma.round.create({
      data: {
        seedId: seed.id,
        nonce: BigInt(seed.chainIndex),
        crashPoint,
        status: "waiting" as Phase,
        bettingOpensAt: new Date(Date.now() + PHASE_MS.waiting),
      },
    });
    this.state = {
      roundId: round.id,
      seedId: seed.id,
      phase: "waiting",
      phaseEndsAt: Date.now() + PHASE_MS.waiting,
      startedAt: null,
      crashPoint,
    };
    await this.mirror();
    this.emitPhase("waiting");
    this.schedule(PHASE_MS.waiting, () => this.safe(() => this.enterBetting()));
  }

  private async enterBetting() {
    if (!this.state) return;
    this.state.phase = "betting";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.betting;
    await this.prisma.round.update({ where: { id: this.state.roundId }, data: { status: "betting" } });
    await this.mirror();
    this.emitPhase("betting");
    this.schedule(PHASE_MS.betting, () => this.safe(() => this.enterRunning()));
  }

  private async enterRunning() {
    if (!this.state) return;
    const now = Date.now();
    this.state.phase = "running";
    this.state.startedAt = now;
    this.state.phaseEndsAt = now + 60_000; // upper bound; crash fires earlier
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "running", startedAt: new Date(now) },
    });
    await this.mirror();
    this.emitPhase("running");

    // Time until the precomputed crash multiplier is reached.
    const crashDelay = Math.max(0, Math.log(this.state.crashPoint) / GROWTH);
    this.schedule(crashDelay, () => this.safe(() => this.enterCrashed()));
  }

  private async enterCrashed() {
    if (!this.state) return;
    this.state.phase = "crashed";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.crashed;
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "crashed", crashedAt: new Date() },
    });
    await this.fairness.revealSeed(this.state.seedId); // make the proof public
    await this.mirror();
    this.events.emit("crash", { roundId: this.state.roundId, crashMultiplier: this.state.crashPoint });
    this.emitPhase("crashed");
    this.schedule(PHASE_MS.crashed, () => this.safe(() => this.enterSettling()));
  }

  private async enterSettling() {
    if (!this.state) return;
    this.state.phase = "settling";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.settling;
    await this.prisma.round.update({ where: { id: this.state.roundId }, data: { status: "settling" } });
    await this.mirror();
    // M6 will settle bets here (engine ↔ ledger). For M4 this is a no-op hook.
    this.events.emit("settle", { roundId: this.state.roundId, crashMultiplier: this.state.crashPoint });
    this.emitPhase("settling");
    this.schedule(PHASE_MS.settling, () => this.safe(() => this.enterCompleted()));
  }

  private async enterCompleted() {
    if (!this.state) return;
    this.state.phase = "completed";
    this.state.phaseEndsAt = Date.now() + PHASE_MS.completed;
    await this.prisma.round.update({
      where: { id: this.state.roundId },
      data: { status: "completed", settledAt: new Date() },
    });
    await this.mirror();
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
