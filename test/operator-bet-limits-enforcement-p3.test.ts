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
import {
  serializeBetLimits,
  deserializeBetLimits,
  effectiveLimitsFor,
  type EffectiveBetLimits,
} from "../src/operator/bet-limits";
import { makeAudit } from "./helpers/audit";

/**
 * Phase 3, piece 2 — per-currency operator bet limits ENFORCED on the bet path
 * (+ currency normalisation). Regression suite for the uncommitted change.
 *
 * What this proves, against the diff:
 *   1. serialize/deserialize round-trip (pure) — BigInt-preserving both ways; the
 *      deserializer returns null (never throws) on garbage / missing / negative /
 *      invariant-violating input, so a tampered claim falls back to global defaults.
 *   2. placeBet honours a per-currency {minBet,maxBet,maxWinPerBet} override:
 *      below minBet and above maxBet are rejected `invalid_amount`; within passes
 *      AND the created Bet row carries maxWinPerBet stamped to the per-currency
 *      value. With NO override (guest/internal) the GLOBAL env limits apply
 *      unchanged (byte-for-byte the old behaviour).
 *   3. cashOut clamps the payout to THIS bet's stamped maxWinPerBet (operator
 *      per-currency cap), not the global cap; a null-stamp bet clamps to the
 *      global cap. Proven for BOTH manual cashOut and the server-driven
 *      auto-cashout (evaluateAutoCashouts), which has no socket to carry limits.
 *   4. end-to-end: openFromToken embeds the resolved serialized limits in the play
 *      token's `limits` claim; a currency with no betLimits entry yields NO claim.
 *   5. currency normalisation: a lowercase launch currency yields an UPPERCASE
 *      session/wallet currency, and an "EUR"-keyed betLimits still resolves for a
 *      token currency "eur".
 *
 * Style mirrors test/exposure-cap-h1.test.ts + test/cashout-race-m1.test.ts (real
 * PrismaService, BetsService constructed directly with the internal ledger as the
 * WalletProvider and a fake engine pinned to "betting"/"running") and
 * test/operator-session-c2.test.ts (operator launch → session + walletId).
 *
 * Deterministic + self-cleaning: every synthetic row (operators, journal users,
 * fairness chains/seeds, rounds/bets) is tracked and torn down FK-safe in afterAll.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// One JWT secret shared by the launch/session services AND the gateway-stand-in
// verifier below (mirrors how AuthModule wires JwtModule; the launch token itself
// is signed per-operator with an explicit secret).
const JWT_SECRET = "p3-betlimits-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

// Fake engine: a single mutable knob flips the phase so the SAME instance can drive
// placeBet ("betting") and cashOut / evaluateAutoCashouts ("running"). BetsService
// only reads getPublicState()/currentMultiplier(), so this is all it needs.
let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase,
    phaseEndsAt: Date.now() + 60_000,
    multiplier: liveMult,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => liveMult,
};

const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

// FK-safe teardown trackers (rounds cascade bets; users cascade wallets/ledger/
// profiles; seeds then chains last; operators cascade their GameSessions and the
// journal users are deleted by username tag).
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];
const createdOperatorIds: string[] = [];

async function freshRound(status: "betting" | "running"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 4_100_000 + Math.floor(Math.random() * 1_000_000), // synthetic, out of the live range
      commitHash: "p3commit-" + randomUUID(),
      length: 2,
      salt: "p3salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "p3h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshUser(balance: bigint, currency = "DEMO"): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "p3_" + id.slice(0, 12),
      wallets: { create: { currency, balance } },
      profile: { create: { displayName: "p3" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Insert an already-placed ACTIVE bet (debit assumed taken) for the round, with an
 *  optional per-bet maxWinPerBet stamp — exactly the shape placeBet would persist. */
async function activeBet(opts: {
  roundId: string;
  userId: string;
  walletId: string;
  panel: Panel;
  amount: bigint;
  autoCashout?: number;
  maxWinPerBet?: bigint | null;
}): Promise<string> {
  const betId = randomUUID();
  await prisma.bet.create({
    data: {
      id: betId,
      roundId: opts.roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: opts.panel,
      amount: opts.amount,
      autoCashout: opts.autoCashout ?? null,
      status: "active",
      maxWinPerBet: opts.maxWinPerBet ?? null,
    },
  });
  return betId;
}

/** Provision-style operator with a betLimits config + allowed currencies. */
async function freshOperator(opts: { currencies?: string[]; betLimits?: unknown } = {}) {
  const op = await prisma.operator.create({
    data: {
      code: "op-p3-" + randomUUID().slice(0, 8),
      name: "P3 BetLimits Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: opts.currencies ?? ["EUR"],
      ...(opts.betLimits !== undefined ? { betLimits: opts.betLimits as object } : {}),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
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
    // operator journal users (username tagged op:<operatorId>:…) cascade their
    // wallets/ledger/profile; then directly-created p3_ users; then operators.
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. serialize / deserialize round-trip (pure — no DB)
// ─────────────────────────────────────────────────────────────────────────────
describe("P3.1 serializeBetLimits / deserializeBetLimits round-trip", () => {
  // Table of valid EffectiveBetLimits (BigInt) covering small, large, equal-bound,
  // and zero-minBet cases. Each must round-trip through the serialized (string) form.
  const cases: Array<[string, EffectiveBetLimits]> = [
    ["typical EUR", { minBet: 10n, maxBet: 10_000n, maxWinPerBet: 1_000_000n }],
    ["zero minBet", { minBet: 0n, maxBet: 10n, maxWinPerBet: 10n }],
    ["all-equal bounds", { minBet: 100n, maxBet: 100n, maxWinPerBet: 100n }],
    ["very large (beyond Number.MAX_SAFE_INTEGER)", { minBet: 1n, maxBet: 9_007_199_254_740_993n, maxWinPerBet: 9_007_199_254_740_993n }],
  ];
  for (const [label, x] of cases) {
    test(`round-trips ${label} (BigInt-preserving)`, () => {
      const round = deserializeBetLimits(serializeBetLimits(x));
      expect(round).toEqual(x);
      // genuinely BigInt, not number, and equal value-for-value.
      expect(typeof round!.minBet).toBe("bigint");
      expect(round!.minBet).toBe(x.minBet);
      expect(round!.maxBet).toBe(x.maxBet);
      expect(round!.maxWinPerBet).toBe(x.maxWinPerBet);
    });
  }

  test("the serialized form is JSON/JWT-safe (decimal strings, survives JSON.stringify)", () => {
    const x: EffectiveBetLimits = { minBet: 10n, maxBet: 10_000n, maxWinPerBet: 1_000_000n };
    const s = serializeBetLimits(x);
    expect(s).toEqual({ minBet: "10", maxBet: "10000", maxWinPerBet: "1000000" });
    // surviving a real JSON round-trip (what a JWT claim does) still deserializes.
    expect(deserializeBetLimits(JSON.parse(JSON.stringify(s)))).toEqual(x);
  });

  test("deserialize also accepts numeric fields (defensive BigInt() coercion)", () => {
    // A claim that somehow carried numbers (not strings) must still parse.
    expect(deserializeBetLimits({ minBet: 10, maxBet: 10000, maxWinPerBet: 1000000 })).toEqual({
      minBet: 10n,
      maxBet: 10_000n,
      maxWinPerBet: 1_000_000n,
    });
  });

  // Table of malformed / invariant-violating inputs — each must yield null, never throw.
  const garbage: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "nope"],
    ["a number", 123],
    ["an array", [1, 2, 3]],
    ["empty object (missing fields)", {}],
    ["missing maxWinPerBet", { minBet: "1", maxBet: "2" }],
    ["non-numeric string", { minBet: "abc", maxBet: "2", maxWinPerBet: "3" }],
    ["negative minBet", { minBet: "-1", maxBet: "2", maxWinPerBet: "3" }],
    ["maxBet < minBet", { minBet: "100", maxBet: "10", maxWinPerBet: "1000" }],
    ["maxWinPerBet < maxBet", { minBet: "1", maxBet: "100", maxWinPerBet: "50" }],
    ["float string (BigInt throws)", { minBet: "1.5", maxBet: "2", maxWinPerBet: "3" }],
    ["null field", { minBet: null, maxBet: "2", maxWinPerBet: "3" }],
  ];
  for (const [label, input] of garbage) {
    test(`deserialize returns null (never throws) for ${label}`, () => {
      let out: unknown;
      expect(() => { out = deserializeBetLimits(input); }).not.toThrow();
      expect(out).toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. placeBet — per-currency stake limits + maxWinPerBet stamp
// ─────────────────────────────────────────────────────────────────────────────
describe("P3.2 placeBet enforces per-currency stake limits and stamps maxWinPerBet", () => {
  // A per-currency override whose window is STRICTLY INSIDE the global env defaults
  // (global default minBet=1, maxBet=1_000_000) so a rejection can only come from
  // the override, and an accept proves the override (not the global) governed.
  const LIM = effectiveLimitsFor(
    { EUR: { minBet: 100, maxBet: 5_000, maxWinPerBet: 250_000 } },
    "EUR",
  )!;
  const limits = { minBet: LIM.minBet, maxBet: LIM.maxBet, maxWinPerBet: LIM.maxWinPerBet };

  test("a stake BELOW the per-currency minBet is rejected invalid_amount (passes the global min)", async () => {
    phase = "betting";
    activeRoundId = await freshRound("betting");
    const { userId } = await freshUser(1_000_000n);
    // 50 < override.minBet(100) but >= global minBet(1): only the override can reject it.
    const r = await bets.placeBet(userId, "A", 50, undefined, undefined, limits);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_amount");
    // No row was created (rejected before the reserve insert).
    expect(await prisma.bet.findUnique({ where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } } })).toBeNull();
  });

  test("a stake ABOVE the per-currency maxBet is rejected invalid_amount (within the global max)", async () => {
    phase = "betting";
    activeRoundId = await freshRound("betting");
    const { userId } = await freshUser(1_000_000n);
    // 9000 > override.maxBet(5000) but < global maxBet(1_000_000): only the override rejects.
    const r = await bets.placeBet(userId, "A", 9_000, undefined, undefined, limits);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_amount");
    expect(await prisma.bet.findUnique({ where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } } })).toBeNull();
  });

  test("a stake WITHIN the window passes AND the Bet row is stamped with the per-currency maxWinPerBet", async () => {
    phase = "betting";
    activeRoundId = await freshRound("betting");
    const { userId, walletId } = await freshUser(1_000_000n);
    const r = await bets.placeBet(userId, "A", 1_000, undefined, undefined, limits);
    expect(r.ok).toBe(true);

    const bet = await prisma.bet.findUniqueOrThrow({
      where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } },
    });
    expect(bet.status).toBe("active");
    expect(bet.amount).toBe(1_000n);
    // THE stamp: the bet carries the per-currency single-bet win cap (Phase 3) so
    // cashOut (incl. auto) caps to it without re-reading the token.
    expect(bet.maxWinPerBet).toBe(limits.maxWinPerBet);
    expect(bet.maxWinPerBet).toBe(250_000n);
    // money moved exactly once.
    expect(await ledger.getBalance(walletId)).toBe(1_000_000n - 1_000n);
  });

  test("boundary stakes (== minBet and == maxBet) are ACCEPTED (inclusive window)", async () => {
    phase = "betting";
    activeRoundId = await freshRound("betting");
    const { userId } = await freshUser(1_000_000n);
    // exactly minBet on panel A …
    const lo = await bets.placeBet(userId, "A", Number(limits.minBet), undefined, undefined, limits);
    expect(lo.ok).toBe(true);
    // … and exactly maxBet on panel B (same round/user, different panel — allowed).
    const hi = await bets.placeBet(userId, "B", Number(limits.maxBet), undefined, undefined, limits);
    expect(hi.ok).toBe(true);
  });

  test("with NO limits override (guest/internal) the GLOBAL env limits apply unchanged", async () => {
    phase = "betting";
    activeRoundId = await freshRound("betting");
    const { userId } = await freshUser(2_000_000n);

    // Above the OVERRIDE max (5000) but under the GLOBAL max (1_000_000): with no
    // override passed it must be ACCEPTED — proving the optional arg defaults to global.
    const ok = await bets.placeBet(userId, "A", 9_000);
    expect(ok.ok).toBe(true);
    const okBet = await prisma.bet.findUniqueOrThrow({
      where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } },
    });
    // No per-currency cap → maxWinPerBet stays null (cashOut then uses the global cap).
    expect(okBet.maxWinPerBet).toBeNull();

    // Above the GLOBAL max → rejected invalid_amount under the global default, same as before P3.
    const over = await bets.placeBet(userId, "B", 1_000_001);
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("invalid_amount");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. cashOut / evaluateAutoCashouts — per-bet win cap clamp
// ─────────────────────────────────────────────────────────────────────────────
describe("P3.3 cashOut caps payout to the bet's stamped maxWinPerBet (per-currency), else global", () => {
  // RUNNING multiplier 2.0. Stakes chosen so raw payout = stake*2.
  // Global default maxWinPerBet = 100_000_000 (RISK_MAX_WIN_PER_BET) under the test env.
  const GLOBAL_CAP = risk.limits.maxWinPerBet;

  test("manual cashOut clamps to the small per-currency cap (below the global cap)", async () => {
    phase = "running";
    liveMult = 2.0;
    activeRoundId = await freshRound("running");
    const { userId, walletId } = await freshUser(0n);
    const stake = 1_000n;
    const perBetCap = 500n; // far below stake*2 (2000) AND far below the global cap
    await activeBet({ roundId: activeRoundId, userId, walletId, panel: "A", amount: stake, maxWinPerBet: perBetCap });

    const r = await bets.cashOut(userId, "A");
    expect(r.ok).toBe(true);
    // raw payout would be 2000, but the PER-CURRENCY cap clamps it to 500.
    expect(r.payout).toBe(Number(perBetCap));

    const bet = await prisma.bet.findUniqueOrThrow({ where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } } });
    expect(bet.payout).toBe(perBetCap);
    expect(bet.status).toBe("cashed_out");
    // wallet credited exactly the clamped payout (started at 0; debit already taken before the test).
    expect(await ledger.getBalance(walletId)).toBe(perBetCap);
  });

  test("manual cashOut on a NULL-stamp bet clamps to the GLOBAL cap (not the per-bet path)", async () => {
    // Stake huge so raw payout exceeds the global cap; null stamp → global governs.
    phase = "running";
    liveMult = 2.0;
    activeRoundId = await freshRound("running");
    const { userId, walletId } = await freshUser(0n);
    const stake = GLOBAL_CAP; // raw payout = 2*GLOBAL_CAP > GLOBAL_CAP
    await activeBet({ roundId: activeRoundId, userId, walletId, panel: "A", amount: stake, maxWinPerBet: null });

    const r = await bets.cashOut(userId, "A");
    expect(r.ok).toBe(true);
    expect(BigInt(r.payout!)).toBe(GLOBAL_CAP); // clamped to the house default, exactly as pre-P3
    expect(await ledger.getBalance(walletId)).toBe(GLOBAL_CAP);
  });

  test("per-bet cap does NOT inflate a small payout (only clamps; min() semantics)", async () => {
    // raw payout (200) is UNDER the per-bet cap (10000) → pays the raw, not the cap.
    phase = "running";
    liveMult = 2.0;
    activeRoundId = await freshRound("running");
    const { userId, walletId } = await freshUser(0n);
    await activeBet({ roundId: activeRoundId, userId, walletId, panel: "A", amount: 100n, maxWinPerBet: 10_000n });

    const r = await bets.cashOut(userId, "A");
    expect(r.ok).toBe(true);
    expect(r.payout).toBe(200); // 100 * 2.0, unclamped (below the cap)
    expect(await ledger.getBalance(walletId)).toBe(200n);
  });

  test("SERVER-DRIVEN auto-cashout uses the per-bet cap (no socket to carry limits)", async () => {
    // This is the load-bearing path: evaluateAutoCashouts → cashOut(atMultiplier=target)
    // reads the cap OFF THE BET. Auto target 2.0 → raw 2000, clamped to the 500 stamp.
    phase = "running";
    liveMult = 2.0;
    activeRoundId = await freshRound("running");
    const { userId, walletId } = await freshUser(0n);
    const stake = 1_000n;
    const perBetCap = 500n;
    await activeBet({
      roundId: activeRoundId, userId, walletId, panel: "A", amount: stake, autoCashout: 2.0, maxWinPerBet: perBetCap,
    });

    const results = await bets.evaluateAutoCashouts(2.0);
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].payout).toBe(Number(perBetCap)); // capped by the stamped per-bet value

    const bet = await prisma.bet.findUniqueOrThrow({ where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } } });
    expect(bet.payout).toBe(perBetCap);
    expect(bet.status).toBe("cashed_out");
    expect(await ledger.getBalance(walletId)).toBe(perBetCap);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. end-to-end: openFromToken → the play token's `limits` claim
// ─────────────────────────────────────────────────────────────────────────────
describe("P3.4 openFromToken embeds the resolved per-currency limits in the play token", () => {
  const CFG = {
    EUR: { minBet: 100, maxBet: 5_000, maxWinPerBet: 250_000 },
    USDT: { minBet: 1, maxBet: 9_999, maxWinPerBet: 50_000 },
  };

  test("a configured currency rides on the token's `limits` claim (deserializes to the operator's values)", async () => {
    const op = await freshOperator({ currencies: ["EUR", "USDT"], betLimits: CFG });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-eur", currency: "EUR", locale: "en" });
    const session = await sessions.openFromToken(tok);

    // The gateway verifies the play token with OUR secret and reads payload.limits.
    const payload = await jwt.verifyAsync(session.token!);
    expect(payload.limits).toBeDefined();
    expect(payload.limits).toEqual({ minBet: "100", maxBet: "5000", maxWinPerBet: "250000" });

    // And exactly what deserializeBetLimits (the gateway's step) yields = the
    // operator's effective EUR limits.
    const lim = deserializeBetLimits(payload.limits);
    expect(lim).toEqual(effectiveLimitsFor(CFG, "EUR"));
    expect(lim).toEqual({ minBet: 100n, maxBet: 5_000n, maxWinPerBet: 250_000n });
  });

  test("a currency with NO betLimits entry yields NO `limits` claim (global fallback)", async () => {
    // Operator allows GBP but only configured EUR/USDT limits → GBP has no entry.
    const op = await freshOperator({ currencies: ["GBP"], betLimits: CFG });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-gbp", currency: "GBP", locale: "en" });
    const session = await sessions.openFromToken(tok);

    const payload = await jwt.verifyAsync(session.token!);
    expect(payload.limits).toBeUndefined(); // no claim → the bet path uses global defaults
    expect(deserializeBetLimits(payload.limits)).toBeNull();
  });

  test("an operator with NO betLimits at all yields NO `limits` claim", async () => {
    const op = await freshOperator({ currencies: ["EUR"] }); // betLimits unset
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-none", currency: "EUR" });
    const session = await sessions.openFromToken(tok);
    const payload = await jwt.verifyAsync(session.token!);
    expect(payload.limits).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. currency normalisation
// ─────────────────────────────────────────────────────────────────────────────
describe("P3.5 currency normalisation (ISO-4217 uppercase) through openFromToken", () => {
  test("a lowercase launch currency yields an UPPERCASE session/wallet currency", async () => {
    const op = await freshOperator({ currencies: ["EUR"] });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-lc", currency: "eur", locale: "en" });
    const session = await sessions.openFromToken(tok);

    expect(session.currency).toBe("EUR");
    // the bound journal wallet is stored canonical UPPERCASE …
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } });
    expect(wallet.currency).toBe("EUR");
    // … and so is the token's currency claim.
    const payload = await jwt.verifyAsync(session.token!);
    expect(payload.currency).toBe("EUR");
  });

  test('betLimits keyed "EUR" resolve for a token currency "eur" (limits claim present + correct)', async () => {
    // The crux of normalisation tying into limits: the operator stored "EUR"
    // limits, the launch token says "eur" — the resolved claim must still be EUR's.
    const CFG = { EUR: { minBet: 100, maxBet: 5_000, maxWinPerBet: 250_000 } };
    const op = await freshOperator({ currencies: ["EUR"], betLimits: CFG });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-lc2", currency: "eur" });
    const session = await sessions.openFromToken(tok);

    expect(session.currency).toBe("EUR");
    const payload = await jwt.verifyAsync(session.token!);
    expect(deserializeBetLimits(payload.limits)).toEqual({ minBet: 100n, maxBet: 5_000n, maxWinPerBet: 250_000n });
  });
});
