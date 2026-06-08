import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService, type Panel } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { deserializeRg, type EffectiveRg } from "../src/operator/rg-config";
import { rgEvaluate, type RgSocketState } from "../src/game/game.gateway";
import { makeAudit } from "./helpers/audit";

/**
 * Phase 3 — responsible-gambling ENFORCEMENT (DB-backed). Mirrors the P3 bet-limits
 * enforcement suite (real Prisma, BetsService with the ledger as WalletProvider, a
 * fake engine phase knob). Proves: session accounting (derive-from-bets) semantics +
 * session scoping; placeBet enforces loss/wager/time + reality-check-pending; DEMO &
 * guests SKIP RG; cash-out is NEVER blocked; per-currency; the rg claim rides the
 * SIGNED token (un-forgeable); and the pure rgEvaluate timer logic.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const JWT_SECRET = "rg-enforce-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: liveMult, serverTime: Date.now() }),
  currentMultiplier: () => liveMult,
};
const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];

async function makeRound(status: string): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 4_300_000 + Math.floor(Math.random() * 1_000_000), commitHash: "rg-" + randomUUID(), length: 2, salt: "rg-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "rg-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshOperator(opts: { currencies?: string[]; rgConfig?: unknown; demoEnabled?: boolean }) {
  const op = await prisma.operator.create({
    data: {
      code: "op-rg-" + randomUUID().slice(0, 8),
      name: "RG Operator",
      enabled: true,
      demoEnabled: opts.demoEnabled ?? false,
      launchSecret: "secret-" + randomUUID(),
      currencies: (opts.currencies ?? ["EUR"]).map((c) => c.toUpperCase()),
      ...(opts.rgConfig !== undefined ? { rgConfig: opts.rgConfig as object } : {}),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Launch a session, fund its journal wallet (so accepted bets can debit the ledger),
 *  and decode the play token → the RG context an accepted bet would carry. */
async function openSession(opts: { rgConfig?: unknown; currency?: string; playerId?: string; demo?: boolean } = {}) {
  const currency = opts.currency ?? "EUR";
  const op = await freshOperator({ currencies: [currency], rgConfig: opts.rgConfig, demoEnabled: opts.demo });
  const token = await launch.issue({ operatorId: op.id, playerId: opts.playerId ?? "p-" + randomUUID().slice(0, 8), currency, demo: opts.demo });
  const s = await sessions.openFromToken(token);
  const payload: any = await jwt.verifyAsync(s.token!);
  await prisma.wallet.update({ where: { id: s.walletId }, data: { balance: 100_000_000n } });
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  return {
    op,
    userId: wallet.userId,
    walletId: s.walletId,
    currency,
    sessionStartedAt: payload.sessionStartedAt as number,
    rg: deserializeRg(payload.rg),
    rgClaim: payload.rg,
    token: s.token!,
  };
}

/** Seed a settled bet on its OWN round (doesn't touch activeRoundId) so session
 *  accounting has prior activity. */
async function seedBet(walletId: string, userId: string, o: { amount: bigint; status: string; payout?: bigint; createdAt?: Date; panel?: Panel }) {
  const roundId = await makeRound("crashed");
  await prisma.bet.create({
    data: {
      id: randomUUID(),
      roundId,
      userId,
      walletId,
      panel: o.panel ?? "A",
      amount: o.amount,
      status: o.status,
      payout: o.payout ?? 0n,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      // F-017: user→wallet (+ wallet→ledger/bet) is now RESTRICT (was CASCADE) — delete the
      // child rows first, then the users (mirrors reserving-backlog-low4 child-first teardown).
      const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
      await prisma.bet.deleteMany({ where: { wallet: opUser } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
      await prisma.profile.deleteMany({ where: opUser });
      await prisma.wallet.deleteMany({ where: opUser });
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RG.1 sessionAccounting — status semantics + session scoping", () => {
  test("counts wagered/won by status; scopes to createdAt >= session start", async () => {
    const s = await openSession();
    const since = new Date(s.sessionStartedAt);
    // One bet of each status (post-session).
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "reserving" }); // pre-debit → NOT wagered
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "cancelled" }); // refunded → NOT wagered
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "cancelling" }); // refunding → NOT wagered
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "active" }); // debited → wagered, payout 0
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "busted" }); // debited → wagered, payout 0
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "cashed_out", payout: 2500n }); // wagered + won
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "payout_pending", payout: 1500n }); // owed win → wagered + won
    // A bet BEFORE the session start (same wallet, prior session) must be excluded.
    await seedBet(s.walletId, s.userId, { amount: 9999n, status: "busted", createdAt: new Date(s.sessionStartedAt - 60_000) });

    const acc = await bets.sessionAccounting(s.walletId, since);
    expect(acc.wagered).toBe(4000n); // active + busted + cashed_out + payout_pending
    expect(acc.won).toBe(4000n); // 2500 + 1500
    expect(acc.net).toBe(0n); // 4000 − 4000
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RG.2 placeBet enforcement", () => {
  async function bettingRound() {
    phase = "betting";
    activeRoundId = await makeRound("betting");
  }

  test("WAGER limit: projects the new stake; > cap rejected, == cap accepted", async () => {
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionWager: 5000 } } } });
    expect(s.rg?.maxSessionWager).toBe(5000n);
    await seedBet(s.walletId, s.userId, { amount: 3000n, status: "active" }); // wagered 3000
    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };

    await bettingRound();
    const over = await bets.placeBet(s.userId, "A", 2001, undefined, s.walletId, undefined, false, ctx);
    expect(over).toMatchObject({ ok: false, reason: "session_wager_limit" });

    await bettingRound();
    const onCap = await bets.placeBet(s.userId, "A", 2000, undefined, s.walletId, undefined, false, ctx); // 3000+2000=5000 == cap
    expect(onCap.ok).toBe(true);
  });

  test("LOSS limit: at-risk projection; a prior win restores headroom", async () => {
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionLoss: 5000 } } } });
    expect(s.rg?.maxSessionLoss).toBe(5000n);
    await seedBet(s.walletId, s.userId, { amount: 4000n, status: "busted" }); // net loss 4000
    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };

    await bettingRound();
    const over = await bets.placeBet(s.userId, "A", 2000, undefined, s.walletId, undefined, false, ctx); // 4000+2000 > 5000
    expect(over).toMatchObject({ ok: false, reason: "session_loss_limit" });

    // A win reduces net → headroom returns.
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "cashed_out", payout: 3500n }); // net now 4000+1000−3500 = 1500
    await bettingRound();
    const ok = await bets.placeBet(s.userId, "A", 2000, undefined, s.walletId, undefined, false, ctx); // 1500+2000=3500 <= 5000
    expect(ok.ok).toBe(true);
  });

  test("TIME limit: past the window rejected, within accepted", async () => {
    const s = await openSession({ rgConfig: { maxSessionSec: 3600 } });
    const rg: EffectiveRg = { enforceRealityCheck: true, maxSessionSec: 3600 };

    await bettingRound();
    const expired = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg, sessionStartedAt: Date.now() - 3700 * 1000 });
    expect(expired).toMatchObject({ ok: false, reason: "session_time_limit" });

    await bettingRound();
    const within = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg, sessionStartedAt: Date.now() - 60 * 1000 });
    expect(within.ok).toBe(true);
  });

  test("REALITY-CHECK pending blocks new bets in enforce mode; not in notify mode", async () => {
    const s = await openSession({ rgConfig: { realityCheckIntervalSec: 3600 } });
    const enforce: EffectiveRg = { enforceRealityCheck: true, realityCheckIntervalSec: 3600 };
    const notify: EffectiveRg = { enforceRealityCheck: false, realityCheckIntervalSec: 3600 };

    await bettingRound();
    const blocked = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg: enforce, rgPending: true, sessionStartedAt: s.sessionStartedAt });
    expect(blocked).toMatchObject({ ok: false, reason: "reality_check_pending" });

    await bettingRound();
    const okEnforceNotPending = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg: enforce, rgPending: false, sessionStartedAt: s.sessionStartedAt });
    expect(okEnforceNotPending.ok).toBe(true);

    await bettingRound();
    const okNotifyEvenIfPending = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg: notify, rgPending: true, sessionStartedAt: s.sessionStartedAt });
    expect(okNotifyEvenIfPending.ok).toBe(true); // notify mode never blocks
  });

  test("DEMO skip (defense-in-depth): a demo bet is accepted even with a breaching rg ctx", async () => {
    const s = await openSession({ demo: true, rgConfig: { limits: { EUR: { maxSessionWager: 1, maxSessionLoss: 1 } }, maxSessionSec: 60 } });
    expect(s.rgClaim).toBeUndefined(); // layer 1: a demo token carries NO rg claim
    // layer 2: even if an rg ctx is somehow present, `demo=true` short-circuits all RG.
    const breaching: EffectiveRg = { enforceRealityCheck: true, maxSessionLoss: 1n, maxSessionWager: 1n, maxSessionSec: 60 };
    await bettingRound();
    const r = await bets.placeBet(s.userId, "A", 5000, undefined, s.walletId, undefined, true, { rg: breaching, rgPending: true, sessionStartedAt: Date.now() - 999_000 });
    expect(r.ok).toBe(true); // play money is never RG-blocked
  });

  test("NO rgConfig → no rg claim → byte-for-byte the pre-RG path", async () => {
    const s = await openSession(); // no rgConfig
    expect(s.rgClaim).toBeUndefined();
    expect(s.rg).toBeNull();
    await bettingRound();
    const r = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg: undefined, sessionStartedAt: s.sessionStartedAt });
    expect(r.ok).toBe(true);
  });

  test("cash-out is NEVER RG-blocked (an at-risk player can always get money out)", async () => {
    // Place an active bet within limits, then prove cashOut succeeds — cashOut takes no
    // RG context by construction, so RG only ever gates placeBet, never a cash-out.
    const s = await openSession({ rgConfig: { maxSessionSec: 3600, limits: { EUR: { maxSessionLoss: 5000 } } } });
    await bettingRound();
    const placed = await bets.placeBet(s.userId, "A", 1000, undefined, s.walletId, undefined, false, { rg: s.rg!, sessionStartedAt: s.sessionStartedAt });
    expect(placed.ok).toBe(true);
    phase = "running";
    liveMult = 2.0;
    // The authoritative crash gate (bets.service Finding 1) reads the bet's OWN DB Round
    // row, so a legitimate running cash-out needs the DB round `running` with crashPoint
    // (5.0) > the cash-out mult (2.0). Mirror the engine's running phase in the DB.
    await prisma.round.update({ where: { id: activeRoundId }, data: { status: "running" } });
    const c = await bets.cashOut(s.userId, "A");
    expect(c.ok).toBe(true); // not blocked by RG
  });

  test("per-currency: an operator's EUR loss cap applies to a EUR session", async () => {
    const s = await openSession({ currency: "EUR", rgConfig: { limits: { EUR: { maxSessionLoss: 2000 }, USDT: { maxSessionWager: 999999 } } } });
    expect(s.rg?.maxSessionLoss).toBe(2000n);
    expect(s.rg?.maxSessionWager).toBeUndefined(); // EUR has no wager cap configured
    await seedBet(s.walletId, s.userId, { amount: 1500n, status: "busted" });
    await bettingRound();
    const over = await bets.placeBet(s.userId, "A", 600, undefined, s.walletId, undefined, false, { rg: s.rg!, sessionStartedAt: s.sessionStartedAt }); // 1500+600 > 2000
    expect(over).toMatchObject({ ok: false, reason: "session_loss_limit" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RG.2b — the GO-LIVE HARDENING: the RG loss/wager cap is now a HARD cap evaluated
// INSIDE the reserve lock (all of a session's bets are on the current round, so they
// share the per-round advisory lock → serialized). This closes the soft-cap TOCTOU:
// two concurrent same-session bets can no longer both read a stale pre-debit snapshot
// and collectively blow past the cap. The in-lock total ALSO counts in-flight
// `reserving` stakes (which sessionAccounting excludes), so a concurrent reservation
// can't slip a bet past the cap either.
describe("RG.2b TOCTOU hard-cap closure (concurrent same-session)", () => {
  async function bettingRound() {
    phase = "betting";
    activeRoundId = await makeRound("betting");
  }

  test("WAGER cap: two concurrent bets that JOINTLY breach → exactly one accepted, one rejected", async () => {
    // cap 5000; already wagered 3000 → headroom 2000. Two concurrent 1500 stakes each
    // pass in isolation (3000+1500=4500 <= 5000) but jointly breach (3000+1500+1500=6000).
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionWager: 5000 } } } });
    expect(s.rg?.maxSessionWager).toBe(5000n);
    await seedBet(s.walletId, s.userId, { amount: 3000n, status: "active" }); // prior wagered 3000
    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };

    await bettingRound();
    // DIFFERENT panels (A + B) so the [round,user,panel] unique can't reject one as
    // `already_bet` — any rejection here must be the RG hard cap, not a panel clash.
    const [a, b] = await Promise.all([
      bets.placeBet(s.userId, "A", 1500, undefined, s.walletId, undefined, false, ctx),
      bets.placeBet(s.userId, "B", 1500, undefined, s.walletId, undefined, false, ctx),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const rejected = [a, b].filter((r) => !r.ok);
    // THE MONEY INVARIANT: the cap must hold — wagered NEVER exceeds maxSessionWager.
    // (Under the OLD pre-lock soft check both bets read wagered=3000 and BOTH passed →
    // wagered=6000. Fail-first verified: reverting to the soft check fails this.)
    // NOTE (intermittent): a real, low-probability TOCTOU survives in the in-lock hard
    // cap under Bun+Prisma — the 2nd tx's `reserving` read can miss the 1st tx's
    // just-committed row (its exposure read, same tx, DOES see it), letting BOTH pass.
    // When that fires this assertion FAILS — that is a REAL bug being caught, NOT test
    // flake; see the agent report. Do NOT relax this to make it pass.
    const acc = await bets.sessionAccounting(s.walletId, new Date(s.sessionStartedAt));
    if (acc.wagered > 5000n || oks.length !== 1) {
      console.error(
        `[RG TOCTOU BUG] wager cap BREACHED: oks=${oks.length} wagered=${acc.wagered} (cap 5000). ` +
          `This is a REAL concurrency bug (in-lock RG read missed a concurrent reserving row), NOT test flake. Do NOT relax this test.`,
      );
    }
    expect(acc.wagered).toBeLessThanOrEqual(5000n); // cap held — no money created
    expect(oks.length).toBe(1); // EXACTLY one wins the lock-serialized cap
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBe("session_wager_limit");
    expect(acc.wagered).toBe(4500n); // 3000 prior + 1500 accepted (the loser never debited)
  });

  test("LOSS cap: two concurrent bets that JOINTLY breach → exactly one accepted, one rejected", async () => {
    // cap 5000; prior net loss 3000 → headroom 2000. Two concurrent 1500 at-risk stakes
    // each pass alone (3000+1500=4500) but jointly breach (3000+1500+1500=6000).
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionLoss: 5000 } } } });
    expect(s.rg?.maxSessionLoss).toBe(5000n);
    await seedBet(s.walletId, s.userId, { amount: 3000n, status: "busted" }); // prior net loss 3000
    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };

    await bettingRound();
    const [a, b] = await Promise.all([
      bets.placeBet(s.userId, "A", 1500, undefined, s.walletId, undefined, false, ctx),
      bets.placeBet(s.userId, "B", 1500, undefined, s.walletId, undefined, false, ctx),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const rejected = [a, b].filter((r) => !r.ok);
    // Same MONEY INVARIANT + same intermittent-TOCTOU caveat as the WAGER test above —
    // an assertion failure here is the real bug surfacing, not flake. Do NOT relax it.
    const acc = await bets.sessionAccounting(s.walletId, new Date(s.sessionStartedAt));
    if (acc.net > 5000n || oks.length !== 1) {
      console.error(
        `[RG TOCTOU BUG] loss cap BREACHED: oks=${oks.length} net=${acc.net} (cap 5000). ` +
          `This is a REAL concurrency bug, NOT test flake. Do NOT relax this test.`,
      );
    }
    expect(acc.net).toBeLessThanOrEqual(5000n); // cap held — at-risk loss never exceeds cap
    expect(oks.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBe("session_loss_limit");
    expect(acc.net).toBe(4500n); // 3000 prior + 1500 accepted active stake
  });

  test("CURRENT-round in-flight reserving is COUNTED toward the cap (blocks the next bet)", async () => {
    // cap 5000; committed wagered 3000 + a CONCURRENT in-flight `reserving` 1500 on the
    // CURRENT round = 4500 effective. A 600 bet (5100 > 5000) must be rejected — the RG
    // hard cap derives current-round reserving from the round-exposure read (which reliably
    // sees a concurrent committed reserving row), closing the soft-cap leak.
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionWager: 5000 } } } });
    await seedBet(s.walletId, s.userId, { amount: 3000n, status: "active" }); // committed wagered 3000

    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };
    await bettingRound();
    // A concurrent in-flight reservation on the CURRENT round (different panel, same wallet).
    await prisma.bet.create({
      data: { id: randomUUID(), roundId: activeRoundId, userId: s.userId, walletId: s.walletId, panel: "B", amount: 1500n, status: "reserving" },
    });

    // sessionAccounting alone EXCLUDES reserving (sees only 3000) → would wrongly allow 600.
    const accNoReserving = await bets.sessionAccounting(s.walletId, new Date(s.sessionStartedAt));
    expect(accNoReserving.wagered).toBe(3000n);

    const r = await bets.placeBet(s.userId, "A", 600, undefined, s.walletId, undefined, false, ctx);
    expect(r).toMatchObject({ ok: false, reason: "session_wager_limit" }); // current-round reserving counted in
  });

  test("STALE prior-round reserving dust is NOT counted (money never debited → not wagered)", async () => {
    // cap 5000; committed wagered 3000 + a large STALE `reserving` 9000 on a PRIOR round
    // (a stranded pre-debit slot awaiting the sweep). It must NOT count — money was never
    // debited, and only the current betting window holds genuine concurrent reservations.
    // So a 600 bet (3000 + 0 + 600 = 3600 ≤ 5000) is ALLOWED. If dust were counted it would
    // wrongly block. (Closes the money-path-auditor L1 over-count.)
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionWager: 5000 } } } });
    await seedBet(s.walletId, s.userId, { amount: 3000n, status: "active" }); // committed 3000
    await seedBet(s.walletId, s.userId, { amount: 9000n, status: "reserving" }); // prior-round dust → ignored

    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };
    await bettingRound();
    const r = await bets.placeBet(s.userId, "A", 600, undefined, s.walletId, undefined, false, ctx);
    expect(r).toMatchObject({ ok: true }); // dust ignored → within cap
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RG.2c — observability: an RG-blocked bet bumps BOTH the generic rejected counter
// AND the dedicated RG-only counter (Phase 3 go-live). Reads the live prom-client
// counters directly (one shared MetricsService instance across the suite).
describe("RG.2c metric — rg_blocks_total alongside bets_rejected_total", () => {
  async function bettingRound() {
    phase = "betting";
    activeRoundId = await makeRound("betting");
  }
  // Read a single labelled counter value out of the prom-client registry text.
  async function counter(metric: string, reason: string): Promise<number> {
    const text = await metrics.render();
    const re = new RegExp(`^${metric}\\{[^}]*reason="${reason}"[^}]*\\}\\s+(\\d+)`, "m");
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  }

  test("a wager-limit reject increments rg_blocks_total AND bets_rejected_total for the reason", async () => {
    const s = await openSession({ rgConfig: { limits: { EUR: { maxSessionWager: 1000 } } } });
    await seedBet(s.walletId, s.userId, { amount: 1000n, status: "active" }); // already at cap
    const ctx = { rg: s.rg!, sessionStartedAt: s.sessionStartedAt };

    const rejBefore = await counter("vaultrun_bets_rejected_total", "session_wager_limit");
    const rgBefore = await counter("vaultrun_rg_blocks_total", "session_wager_limit");

    await bettingRound();
    const r = await bets.placeBet(s.userId, "A", 1, undefined, s.walletId, undefined, false, ctx);
    expect(r).toMatchObject({ ok: false, reason: "session_wager_limit" });

    const rejAfter = await counter("vaultrun_bets_rejected_total", "session_wager_limit");
    const rgAfter = await counter("vaultrun_rg_blocks_total", "session_wager_limit");
    expect(rejAfter).toBe(rejBefore + 1);
    expect(rgAfter).toBe(rgBefore + 1);
  });

  test("a reality-check-pending reject also increments both counters for its reason", async () => {
    const s = await openSession({ rgConfig: { realityCheckIntervalSec: 3600 } });
    const enforce: EffectiveRg = { enforceRealityCheck: true, realityCheckIntervalSec: 3600 };
    const rejBefore = await counter("vaultrun_bets_rejected_total", "reality_check_pending");
    const rgBefore = await counter("vaultrun_rg_blocks_total", "reality_check_pending");

    await bettingRound();
    const r = await bets.placeBet(s.userId, "A", 100, undefined, s.walletId, undefined, false, { rg: enforce, rgPending: true, sessionStartedAt: s.sessionStartedAt });
    expect(r).toMatchObject({ ok: false, reason: "reality_check_pending" });

    expect(await counter("vaultrun_bets_rejected_total", "reality_check_pending")).toBe(rejBefore + 1);
    expect(await counter("vaultrun_rg_blocks_total", "reality_check_pending")).toBe(rgBefore + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RG.3 token claims + un-forgeability", () => {
  test("a real RG session embeds `rg` + `sessionStartedAt` on the signed play token", async () => {
    const s = await openSession({ rgConfig: { realityCheckIntervalSec: 3600, limits: { EUR: { maxSessionLoss: 50000 } } } });
    expect(typeof s.sessionStartedAt).toBe("number");
    expect(s.rg).toEqual({ enforceRealityCheck: true, realityCheckIntervalSec: 3600, maxSessionLoss: 50000n });
  });

  test("a currency with no money cap still carries the currency-agnostic interval", async () => {
    const s = await openSession({ currency: "EUR", rgConfig: { realityCheckIntervalSec: 1800, limits: { USDT: { maxSessionLoss: 1 } } } });
    expect(s.rg).toEqual({ enforceRealityCheck: true, realityCheckIntervalSec: 1800 });
  });

  test("a forged token carrying a permissive `rg` is rejected at the SIGNATURE", async () => {
    // The play token is signed with OUR JWT_SECRET; the gateway verifies it at connect.
    // A token forged with any other secret — even with a wide-open `rg` — fails to verify,
    // so an attacker can't mint or downgrade their own RG controls.
    const forger = new JwtService({ secret: "attacker-secret" });
    const forged = await forger.signAsync({
      sub: randomUUID(),
      kind: "operator",
      sessionId: randomUUID(),
      rg: { enforceRealityCheck: false, maxSessionLoss: "999999999" },
      sessionStartedAt: Date.now(),
    });
    await expect(jwt.verifyAsync(forged)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RG.4 rgEvaluate (pure timer logic)", () => {
  const base = (over: Partial<RgSocketState> = {}): RgSocketState => ({
    rg: { enforceRealityCheck: true, realityCheckIntervalSec: 3600, maxSessionSec: 86400 },
    sessionStartedAt: 1_000_000,
    rgRealityDueAt: 1_000_000 + 3600 * 1000,
    rgPending: false,
    rgTimeLimitNotified: false,
    ...over,
  });

  test("reality check fires at due time, sets pending in enforce mode, advances from now", () => {
    const now = 1_000_000 + 3600 * 1000 + 5;
    const d = rgEvaluate(base(), now);
    expect(d.emitRealityCheck).toBe(true);
    expect(d.nextPending).toBe(true);
    expect(d.nextDueAt).toBe(now + 3600 * 1000);
    expect(d.tripTimeLimit).toBe(false);
  });

  test("not due yet → no-op", () => {
    const d = rgEvaluate(base(), 1_000_000 + 100);
    expect(d.emitRealityCheck).toBe(false);
    expect(d.tripTimeLimit).toBe(false);
    expect(d.nextPending).toBe(false);
  });

  test("notify mode does NOT set pending", () => {
    const d = rgEvaluate(base({ rg: { enforceRealityCheck: false, realityCheckIntervalSec: 3600 } }), 1_000_000 + 3600 * 1000 + 5);
    expect(d.emitRealityCheck).toBe(true);
    expect(d.nextPending).toBe(false);
  });

  test("time limit trips ONCE, and suppresses reality checks", () => {
    const now = 1_000_000 + 86400 * 1000 + 5;
    const first = rgEvaluate(base(), now);
    expect(first.tripTimeLimit).toBe(true);
    expect(first.nextTimeLimitNotified).toBe(true);
    expect(first.emitRealityCheck).toBe(false); // time limit takes precedence
    // Already notified → no re-trip.
    const second = rgEvaluate(base({ rgTimeLimitNotified: true }), now);
    expect(second.tripTimeLimit).toBe(false);
  });
});
