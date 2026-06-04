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
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: liveMult, serverTime: Date.now() }),
  currentMultiplier: () => liveMult,
};
const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics);

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
