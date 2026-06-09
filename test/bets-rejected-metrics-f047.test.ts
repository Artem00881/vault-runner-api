import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import type { WalletProvider, WalletTxResult, ReverseParams } from "../src/wallet/wallet-provider";
import type { LedgerType, LedgerRef } from "../src/wallet/ledger.service";
import { makeAudit } from "./helpers/audit";

/**
 * F-047 — DISTINCT rejected-metric labels for the three placeBet failure surfaces, so
 * operator/infra failures are observable apart from the generic `bet_failed` bucket. The
 * CLIENT-facing `reason` stays "bet_failed" on every one (no behavior/leak change); only the
 * `vaultrun_bets_rejected_total{reason=…}` label is split. We spy on metrics.recordRejected to
 * assert the EXACT label, and assert the returned client reason in the same step.
 *
 *   wallet_unavailable — wallet resolution threw a non-ownership error (e.g. a not-found
 *                        walletId). (Was `bet_failed`.)
 *   reserve_failed     — the reserve $transaction threw a non-rejectReason / non-P2002 error
 *                        (e.g. a DB hiccup mid-reservation). (Was `bet_failed`.)
 *   debit_failed       — the wallet debit threw a non-"insufficient_balance" error (e.g. an
 *                        operator/infra failure). (Was `bet_failed`.) A clean insufficient_balance
 *                        is UNCHANGED (it keeps its own distinct label + reason).
 *
 * FAILS-FIRST against the pre-F-047 code: all three recorded `bet_failed`, so each distinct-label
 * assertion (and the "bet_failed bucket did NOT move" assertion) fails.
 *
 * Real Prisma (the round/wallet FKs + the reserve tx are real); a fake engine pins the betting
 * window; the failure on each path is injected (a non-existent walletId / a $transaction spy / a
 * throwing wallet provider) so the exact branch fires deterministically.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

let activeRoundId = "";
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "betting",
    phaseEndsAt: Date.now() + 5000,
    multiplier: 1.0,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => 1.0,
};

/** A wallet provider whose `debit` throws a generic (non-"insufficient_balance") error. Resolution
 *  is via real Prisma in BetsService, so only the debit leg matters here. */
class ThrowingDebitWallet implements WalletProvider {
  async debit(_walletId: string, _amount: bigint, _type: LedgerType, _key: string, _ref?: LedgerRef): Promise<WalletTxResult> {
    throw new Error("operator_down"); // NOT "insufficient_balance" → must map to debit_failed
  }
  async credit(): Promise<WalletTxResult> {
    throw new Error("unused");
  }
  async rollback(): Promise<void> {}
  async reverse(_walletId: string, _p: ReverseParams): Promise<void> {}
  async getBalance(): Promise<bigint> {
    return 0n;
  }
}

const betsLedger = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));
const betsThrowingDebit = new BetsService(prisma, new ThrowingDebitWallet(), fakeEngine, risk, metrics, makeAudit(prisma, metrics));

// A Prisma whose `$transaction` throws a generic (non-rejectReason, non-P2002) error — the only
// $transaction on the placeBet path is the reserve, so this fires the reserve_failed branch
// deterministically while every other prisma call (the pre-reserve reads) delegates to the real
// client. (A Proxy is more robust here than spyOn: PrismaClient.$transaction lives on the
// prototype, and we want only THIS BetsService instance affected, not the shared client.)
const reserveThrowingPrisma = new Proxy(prisma, {
  get(target, prop, receiver) {
    if (prop === "$transaction") {
      return async () => {
        throw new Error("db_unavailable"); // non-rejectReason + no .code → maps to reserve_failed
      };
    }
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? v.bind(target) : v;
  },
}) as unknown as PrismaService;
const betsReserveFail = new BetsService(reserveThrowingPrisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 1_500_000_000 + Math.floor(Math.random() * 10_000_000), // distinct band, safely < INT4 max (2_147_483_647)
      commitHash: "f047c-" + randomUUID(),
      length: 2,
      salt: "f047s-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "f047h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "f047_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "f047" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

beforeAll(async () => {
  await prisma.$connect();
  activeRoundId = await freshRound();
});
afterAll(async () => {
  try {
    // Drop any reserving slots this suite created, then FK-safe purge (rounds → bets, then
    // seeds/chains, then users cascade wallets/ledger/profile).
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("F-047 distinct rejected-metric labels — client reason stays bet_failed", () => {
  test("wallet resolution not-found → metric=wallet_unavailable, client reason=bet_failed", async () => {
    const { userId } = await freshUser(10_000n);
    const missingWalletId = randomUUID(); // valid UUID shape, no such wallet → findUniqueOrThrow throws

    const spy = spyOn(metrics, "recordRejected");
    try {
      const res = await betsLedger.placeBet(userId, "A", 100, undefined, missingWalletId);
      // Client-facing reason is the generic bet_failed (no info leak).
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("bet_failed");
      // ...but the DISTINCT metric label was recorded (F-047), NOT the generic bet_failed.
      const labels = spy.mock.calls.map((c) => c[0]);
      expect(labels).toContain("wallet_unavailable");
      expect(labels).not.toContain("bet_failed");
    } finally {
      spy.mockRestore();
    }
  });

  test("reserve $transaction throws (non-P2002) → metric=reserve_failed, client reason=bet_failed", async () => {
    const { userId, walletId } = await freshUser(10_000n);

    // betsReserveFail's prisma throws a generic error from the reserve $transaction (a DB hiccup
    // mid-reservation). It is non-rejectReason + has no .code → the reserve_failed branch fires.
    const spy = spyOn(metrics, "recordRejected");
    try {
      const res = await betsReserveFail.placeBet(userId, "A", 100, undefined, walletId);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("bet_failed"); // client reason UNCHANGED
      const labels = spy.mock.calls.map((c) => c[0]);
      expect(labels).toContain("reserve_failed"); // F-047 distinct label
      expect(labels).not.toContain("bet_failed");
    } finally {
      spy.mockRestore();
    }
  });

  test("debit throws (non-insufficient_balance) → metric=debit_failed, client reason=bet_failed", async () => {
    const { userId, walletId } = await freshUser(10_000n);

    const spy = spyOn(metrics, "recordRejected");
    try {
      // The reserve (real Prisma) succeeds; the injected wallet's debit() throws "operator_down".
      const res = await betsThrowingDebit.placeBet(userId, "A", 100, undefined, walletId);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("bet_failed"); // client reason UNCHANGED (mapped from generic failure)
      const labels = spy.mock.calls.map((c) => c[0]);
      expect(labels).toContain("debit_failed"); // F-047 distinct label
      expect(labels).not.toContain("bet_failed");
    } finally {
      spy.mockRestore();
    }

    // The reservation was rolled back (slot deleted) since no money moved — no stranded reserving row.
    const slots = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId, status: "reserving" } });
    expect(slots.length).toBe(0);
  });

  test("CONTRAST: a clean insufficient_balance keeps its OWN label + reason (not remapped to debit_failed)", async () => {
    // A funded-too-low wallet: the internal ledger debit throws "insufficient_balance", which is a
    // normal business rejection — its label and client reason must BOTH stay insufficient_balance.
    const { userId, walletId } = await freshUser(10n); // far below the 100 stake

    const spy = spyOn(metrics, "recordRejected");
    try {
      const res = await betsLedger.placeBet(userId, "A", 100, undefined, walletId);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("insufficient_balance");
      const labels = spy.mock.calls.map((c) => c[0]);
      expect(labels).toContain("insufficient_balance");
      expect(labels).not.toContain("debit_failed");
      expect(labels).not.toContain("bet_failed");
    } finally {
      spy.mockRestore();
    }
  });
});
