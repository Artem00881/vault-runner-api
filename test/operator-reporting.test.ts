import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { ReportingService } from "../src/operator/reporting.service";
import {
  parseReportQuery,
  parseDailyQuery,
  parseBetsQuery,
  MAX_DAILY_RANGE_DAYS,
} from "../src/operator/reporting-query";

/**
 * Phase 3.5 — operator REPORTING aggregation (DB-backed). Seeds an operator with
 * sessions + hand-crafted Bet rows across 2 currencies + every status, then asserts
 * the summary/daily/bets aggregations against HAND-COMPUTED math. The money + status
 * invariants here are also certification evidence (turnover/GGR/RTP must be exact).
 *
 * Invariants:
 *  - WAGERED = active|cashed_out|busted|payout_pending; WON = cashed_out|payout_pending;
 *    GGR = wagered − won (can be negative); betCount = wagered-set rows; rtp 4dp floored;
 *  - uniquePlayers = distinct walletId per currency (one wallet/player/currency);
 *  - demo bets excluded by default (includeDemo=false), included when true;
 *  - TENANT ISOLATION: operator A only ever sees A's rows, even when B has bets;
 *  - date-range scoping (date-only `to` covers the whole UTC day; from>to → 400);
 *  - currency grouping + ?currency= filter;
 *  - MONEY PRECISION: sums > Number.MAX_SAFE_INTEGER emit EXACT decimal strings;
 *  - daily UTC bucketing; bets keyset pagination + playerId resolution + cursor scope.
 */

const prisma = new PrismaService();
const reporting = new ReportingService(prisma);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdUserIds: string[] = [];

// A wide [from,to] window covering everything we seed (all seeded createdAt fall in 2026).
const FROM = new Date("2026-01-01T00:00:00.000Z");
const TO = new Date("2026-12-31T23:59:59.999Z");
const Q = (over: Partial<Record<string, unknown>> = {}) =>
  parseReportQuery({ from: FROM.toISOString(), to: TO.toISOString(), ...over });

async function makeRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 4_400_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "rep-" + randomUUID(),
      length: 2,
      salt: "rep-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "rep-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status: "crashed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshOperator(currencies: string[] = ["EUR", "USDT"]) {
  const op = await prisma.operator.create({
    data: {
      code: "op-rep-" + randomUUID().slice(0, 8),
      name: "Reporting Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: currencies.map((c) => c.toUpperCase()),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Create a real player journal wallet (one per operator+player+currency) and a
 *  GameSession linking walletId → playerId (so the bets ledger can resolve playerId). */
async function makePlayer(operatorId: string, playerId: string, currency: string) {
  const user = await prisma.user.create({
    data: { username: `op:${operatorId}:${playerId}:${currency}:${randomUUID().slice(0, 6)}`, isGuest: false },
  });
  createdUserIds.push(user.id);
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, currency: currency.toUpperCase(), balance: 0n },
  });
  await prisma.gameSession.create({
    data: {
      operatorId,
      playerId,
      currency: currency.toUpperCase(),
      walletId: wallet.id,
      launchJti: "jti-" + randomUUID(),
    },
  });
  return { userId: user.id, walletId: wallet.id, playerId };
}

interface SeedBet {
  amount: bigint;
  status: string;
  payout?: bigint;
  currency?: string; // canonical UPPERCASE stamped on the bet
  demo?: boolean;
  createdAt?: Date;
  operatorId: string;
}
/** Insert a hand-crafted Bet on its own round (avoids the (round,user,panel) unique). */
async function seedBet(walletId: string, userId: string, o: SeedBet): Promise<string> {
  const roundId = await makeRound();
  const id = randomUUID();
  await prisma.bet.create({
    data: {
      id,
      roundId,
      userId,
      walletId,
      panel: "A",
      amount: o.amount,
      status: o.status,
      payout: o.payout ?? 0n,
      demo: o.demo ?? false,
      operatorId: o.operatorId,
      currency: (o.currency ?? "EUR").toUpperCase(),
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      ...(o.status === "cashed_out" || o.status === "busted" ? { settledAt: o.createdAt ?? new Date() } : {}),
    },
  });
  return id;
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
    // Sessions cascade with the operator; wallets/ledger cascade with the user.
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.1 summary — status semantics + GGR/RTP math (hand-computed)", () => {
  test("one bet of every status maps to the WAGERED/WON sets exactly", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-status", "EUR");
    // WAGERED set = active|cashed_out|busted|payout_pending; WON set = cashed_out|payout_pending.
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "reserving" }); // pre-debit → NOT counted
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cancelling" }); // refunding → NOT counted
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cancelled" }); // refunded → NOT counted
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 2000n, status: "active" }); // wagered, won 0
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 3000n, status: "busted" }); // wagered, won 0
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cashed_out", payout: 2500n }); // wagered+won
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "payout_pending", payout: 1500n }); // wagered+won

    const res = await reporting.summary(op.id, Q());
    expect(res.currencies.length).toBe(1);
    const eur = res.currencies[0];
    expect(eur.currency).toBe("EUR");
    expect(eur.betCount).toBe(4); // active+busted+cashed_out+payout_pending
    expect(eur.wagered).toBe("7000"); // 2000+3000+1000+1000
    expect(eur.won).toBe("4000"); // 2500+1500
    expect(eur.ggr).toBe("3000"); // 7000 − 4000
    expect(eur.uniquePlayers).toBe(1);
    // rtp = 4000/7000 = 0.571428… → 4dp floor "0.5714"
    expect(eur.rtp).toBe("0.5714");
  });

  test("negative GGR when won > wagered (a lucky period)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-lucky", "EUR");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cashed_out", payout: 5000n });
    const res = await reporting.summary(op.id, Q());
    const eur = res.currencies[0];
    expect(eur.wagered).toBe("1000");
    expect(eur.won).toBe("5000");
    expect(eur.ggr).toBe("-4000"); // negative GGR preserved
    expect(eur.rtp).toBe("5.0000"); // 5000/1000 = 5.0
  });

  test("rtp = \"0\" when nothing was wagered (only refunded/reserving noise)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-nowager", "EUR");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "reserving" });
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cancelled" });
    const res = await reporting.summary(op.id, Q());
    // No wagered-set rows → currency dropped entirely (betCount filter).
    expect(res.currencies).toEqual([]);
  });

  test("rtp floors (does not round up): 2/3 → 0.6666 not 0.6667", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-floor", "EUR");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 3n, status: "cashed_out", payout: 2n });
    const res = await reporting.summary(op.id, Q());
    expect(res.currencies[0].rtp).toBe("0.6666");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.2 demo exclusion", () => {
  test("includeDemo=false (default) excludes demo bets; =true includes them", async () => {
    const op = await freshOperator(["EUR"]);
    const real = await makePlayer(op.id, "p-real", "EUR");
    const demo = await makePlayer(op.id, "p-demo", "EUR");
    await seedBet(real.walletId, real.userId, { operatorId: op.id, amount: 1000n, status: "busted", demo: false });
    await seedBet(demo.walletId, demo.userId, { operatorId: op.id, amount: 9000n, status: "busted", demo: true });

    const realOnly = await reporting.summary(op.id, Q()); // default includeDemo=false
    expect(realOnly.includeDemo).toBe(false);
    expect(realOnly.currencies[0].wagered).toBe("1000"); // demo 9000 excluded
    expect(realOnly.currencies[0].betCount).toBe(1);
    expect(realOnly.currencies[0].uniquePlayers).toBe(1);

    const withDemo = await reporting.summary(op.id, Q({ includeDemo: "true" }));
    expect(withDemo.includeDemo).toBe(true);
    expect(withDemo.currencies[0].wagered).toBe("10000"); // 1000 + 9000
    expect(withDemo.currencies[0].betCount).toBe(2);
    expect(withDemo.currencies[0].uniquePlayers).toBe(2); // real + demo wallets are distinct journals
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.3 tenant isolation (fail-first invariant)", () => {
  test("operator A's summary returns ONLY A's rows even when B has bets", async () => {
    const opA = await freshOperator(["EUR"]);
    const opB = await freshOperator(["EUR"]);
    const a = await makePlayer(opA.id, "a1", "EUR");
    const b = await makePlayer(opB.id, "b1", "EUR");
    await seedBet(a.walletId, a.userId, { operatorId: opA.id, amount: 1000n, status: "busted" });
    await seedBet(b.walletId, b.userId, { operatorId: opB.id, amount: 7777n, status: "busted" });

    const resA = await reporting.summary(opA.id, Q());
    expect(resA.operatorId).toBe(opA.id);
    expect(resA.currencies[0].wagered).toBe("1000"); // NOT 8777 — B's row is invisible
    expect(resA.currencies[0].betCount).toBe(1);

    const resB = await reporting.summary(opB.id, Q());
    expect(resB.currencies[0].wagered).toBe("7777");
    expect(resB.currencies[0].betCount).toBe(1);
  });

  test("bets ledger is tenant-scoped too: A never sees B's bet ids", async () => {
    const opA = await freshOperator(["EUR"]);
    const opB = await freshOperator(["EUR"]);
    const a = await makePlayer(opA.id, "a2", "EUR");
    const b = await makePlayer(opB.id, "b2", "EUR");
    const aBetId = await seedBet(a.walletId, a.userId, { operatorId: opA.id, amount: 100n, status: "busted" });
    const bBetId = await seedBet(b.walletId, b.userId, { operatorId: opB.id, amount: 200n, status: "busted" });

    const resA = await reporting.bets(opA.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString() }));
    const ids = resA.bets.map((x) => x.id);
    expect(ids).toContain(aBetId);
    expect(ids).not.toContain(bBetId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.4 date-range scoping", () => {
  test("bets outside [from,to] are excluded", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-dates", "EUR");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "busted", createdAt: new Date("2026-06-15T12:00:00Z") });
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 9999n, status: "busted", createdAt: new Date("2025-01-01T12:00:00Z") }); // before
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 8888n, status: "busted", createdAt: new Date("2027-01-01T12:00:00Z") }); // after

    const q = parseReportQuery({ from: "2026-06-01", to: "2026-06-30" });
    const res = await reporting.summary(op.id, q);
    expect(res.currencies[0].wagered).toBe("1000"); // only the in-range bet
  });

  test("a date-only `to` covers the WHOLE day (end-of-day snap)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-eod", "EUR");
    // 23:30 on the 4th must be INCLUDED when to=2026-06-04 (snaps to 23:59:59.999).
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 500n, status: "busted", createdAt: new Date("2026-06-04T23:30:00Z") });
    const q = parseReportQuery({ from: "2026-06-04", to: "2026-06-04" });
    expect(q.to.toISOString()).toBe("2026-06-04T23:59:59.999Z");
    const res = await reporting.summary(op.id, q);
    expect(res.currencies[0].wagered).toBe("500");
  });

  test("from > to → BadRequestException (400)", () => {
    expect(() => parseReportQuery({ from: "2026-06-30", to: "2026-06-01" })).toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.5 currency grouping + filter", () => {
  test("groups per currency, sorted; ?currency=EUR returns only EUR", async () => {
    const op = await freshOperator(["EUR", "USDT"]);
    const eurP = await makePlayer(op.id, "p-eur", "EUR");
    const usdtP = await makePlayer(op.id, "p-usdt", "USDT");
    await seedBet(eurP.walletId, eurP.userId, { operatorId: op.id, amount: 1000n, status: "busted", currency: "EUR" });
    await seedBet(usdtP.walletId, usdtP.userId, { operatorId: op.id, amount: 2000n, status: "busted", currency: "USDT" });

    const all = await reporting.summary(op.id, Q());
    expect(all.currencies.map((c) => c.currency)).toEqual(["EUR", "USDT"]); // sorted
    expect(all.currencies.find((c) => c.currency === "EUR")!.wagered).toBe("1000");
    expect(all.currencies.find((c) => c.currency === "USDT")!.wagered).toBe("2000");

    const eurOnly = await reporting.summary(op.id, Q({ currency: "EUR" }));
    expect(eurOnly.currencies.length).toBe(1);
    expect(eurOnly.currencies[0].currency).toBe("EUR");

    // The filter is canonicalised UPPERCASE — a lowercase query still resolves.
    const lower = await reporting.summary(op.id, Q({ currency: "usdt" }));
    expect(lower.currencies.length).toBe(1);
    expect(lower.currencies[0].currency).toBe("USDT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.6 money precision (BigInt → exact decimal STRING, fail-first)", () => {
  test("sums beyond Number.MAX_SAFE_INTEGER are exact (no float truncation)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-bignum", "EUR");
    // MAX_SAFE_INTEGER = 9_007_199_254_740_991. Two stakes that sum past it; a Number
    // accumulator would lose the low bits and give an even (wrong) total.
    const big = 9_000_000_000_000_000n;
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: big, status: "busted" });
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: big, status: "busted" });
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 7n, status: "busted" }); // odd low bit

    const res = await reporting.summary(op.id, Q());
    expect(res.currencies[0].wagered).toBe("18000000000000007"); // EXACT
    // Sanity: this exceeds 2^53 so a Number would have been lossy.
    expect(BigInt(res.currencies[0].wagered) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // And it is NOT what a float would produce.
    expect(res.currencies[0].wagered).not.toBe(String(9_000_000_000_000_000 + 9_000_000_000_000_000 + 7));
  });

  test("won + ggr are also exact at scale", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-bigwon", "EUR");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 10_000_000_000_000_000n, status: "cashed_out", payout: 9_999_999_999_999_999n });
    const res = await reporting.summary(op.id, Q());
    const eur = res.currencies[0];
    expect(eur.wagered).toBe("10000000000000000");
    expect(eur.won).toBe("9999999999999999");
    expect(eur.ggr).toBe("1"); // 10^16 − (10^16 − 1)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.7 empty results never throw", () => {
  test("an operator with no bets → currencies:[] / days:[] / bets:[]", async () => {
    const op = await freshOperator(["EUR"]);
    const s = await reporting.summary(op.id, Q());
    expect(s.currencies).toEqual([]);
    const d = await reporting.daily(op.id, parseDailyQuery({ from: FROM.toISOString(), to: TO.toISOString() }));
    expect(d.days).toEqual([]);
    const b = await reporting.bets(op.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString() }));
    expect(b.bets).toEqual([]);
    expect(b.nextCursor).toBeNull();
  });

  test("an empty date range (no rows in window) → empty, no throw", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "p-empty", "EUR");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "busted", createdAt: new Date("2026-06-15T12:00:00Z") });
    const q = parseReportQuery({ from: "2020-01-01", to: "2020-01-02" }); // far from the seeded bet
    const s = await reporting.summary(op.id, q);
    expect(s.currencies).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.8 daily buckets (UTC)", () => {
  test("bets across 2 UTC days fall into the correct per-day buckets", async () => {
    const op = await freshOperator(["EUR"]);
    const p1 = await makePlayer(op.id, "d-p1", "EUR");
    const p2 = await makePlayer(op.id, "d-p2", "EUR");
    // Day 1: two players, two bets.
    await seedBet(p1.walletId, p1.userId, { operatorId: op.id, amount: 1000n, status: "busted", createdAt: new Date("2026-06-01T10:00:00Z") });
    await seedBet(p2.walletId, p2.userId, { operatorId: op.id, amount: 2000n, status: "cashed_out", payout: 3000n, createdAt: new Date("2026-06-01T22:00:00Z") });
    // Day 2: one player, one bet.
    await seedBet(p1.walletId, p1.userId, { operatorId: op.id, amount: 500n, status: "busted", createdAt: new Date("2026-06-02T00:30:00Z") });

    const res = await reporting.daily(op.id, parseDailyQuery({ from: "2026-06-01", to: "2026-06-02" }));
    expect(res.days.length).toBe(2);
    const d1 = res.days.find((d) => d.date === "2026-06-01")!;
    const d2 = res.days.find((d) => d.date === "2026-06-02")!;
    expect(d1.wagered).toBe("3000"); // 1000 + 2000
    expect(d1.won).toBe("3000");
    expect(d1.betCount).toBe(2);
    expect(d1.uniquePlayers).toBe(2);
    expect(d2.wagered).toBe("500");
    expect(d2.betCount).toBe(1);
    expect(d2.uniquePlayers).toBe(1);
  });

  test("a UTC-midnight-crossing instant buckets by UTC date, not local", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "d-utc", "EUR");
    // 23:59:59.500Z on the 3rd is the 3rd in UTC.
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 111n, status: "busted", createdAt: new Date("2026-06-03T23:59:59.500Z") });
    // 00:00:00.500Z on the 4th is the 4th in UTC.
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 222n, status: "busted", createdAt: new Date("2026-06-04T00:00:00.500Z") });
    const res = await reporting.daily(op.id, parseDailyQuery({ from: "2026-06-03", to: "2026-06-04" }));
    expect(res.days.find((d) => d.date === "2026-06-03")!.wagered).toBe("111");
    expect(res.days.find((d) => d.date === "2026-06-04")!.wagered).toBe("222");
  });

  test("daily range too large → BadRequestException", () => {
    const from = "2020-01-01";
    const to = new Date(Date.UTC(2020, 0, 1) + (MAX_DAILY_RANGE_DAYS + 5) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(() => parseDailyQuery({ from, to })).toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.9 bets ledger — pagination, playerId resolution, cursor scope", () => {
  test("keyset pagination: limit honored, nextCursor walks pages with no overlap", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "pg-p", "EUR");
    // 5 bets at distinct timestamps (createdAt desc, id desc ordering).
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedBet(p.walletId, p.userId, {
          operatorId: op.id,
          amount: BigInt(100 + i),
          status: "busted",
          createdAt: new Date(`2026-06-10T0${i}:00:00Z`),
        }),
      );
    }

    const page1 = await reporting.bets(op.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "2" }));
    expect(page1.bets.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await reporting.bets(
      op.id,
      parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "2", cursor: page1.nextCursor! }),
    );
    expect(page2.bets.length).toBe(2);

    const page3 = await reporting.bets(
      op.id,
      parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "2", cursor: page2.nextCursor! }),
    );
    expect(page3.bets.length).toBe(1); // 5th
    expect(page3.nextCursor).toBeNull(); // no more

    // Union of all pages == all 5 ids, with NO overlap.
    const seen = [...page1.bets, ...page2.bets, ...page3.bets].map((b) => b.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  test("playerId is resolved via the session (walletId → GameSession.playerId)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "resolved-player-id", "EUR");
    const betId = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 100n, status: "busted" });
    const res = await reporting.bets(op.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString() }));
    const row = res.bets.find((b) => b.id === betId)!;
    expect(row.playerId).toBe("resolved-player-id");
    expect(row.currency).toBe("EUR");
    expect(row.amount).toBe("100");
    expect(row.status).toBe("busted");
  });

  test("limit clamps to 200 (a request for more is capped)", () => {
    const q = parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "999" });
    expect(q.limit).toBe(200);
  });

  test("an invalid limit → BadRequestException", () => {
    expect(() => parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "0" })).toThrow(BadRequestException);
    expect(() => parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "-3" })).toThrow(BadRequestException);
    expect(() => parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), limit: "1.5" })).toThrow(BadRequestException);
  });

  test("a malformed (non-UUID) cursor → BadRequestException at parse time", () => {
    expect(() => parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), cursor: "not-a-uuid" })).toThrow(BadRequestException);
  });

  test("a well-formed cursor NOT owned by this operator → BadRequestException at query time", async () => {
    const opA = await freshOperator(["EUR"]);
    const opB = await freshOperator(["EUR"]);
    const b = await makePlayer(opB.id, "cursor-b", "EUR");
    const bBetId = await seedBet(b.walletId, b.userId, { operatorId: opB.id, amount: 100n, status: "busted" });
    // A's request presenting B's bet id as a cursor must be rejected (no cross-tenant probe).
    await expect(
      reporting.bets(opA.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), cursor: bBetId })),
    ).rejects.toThrow(BadRequestException);
  });

  test("a well-formed cursor for a non-existent bet → BadRequestException", async () => {
    const op = await freshOperator(["EUR"]);
    await expect(
      reporting.bets(op.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString(), cursor: randomUUID() })),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("R.10 per-currency decimals on report rows (Phase 3.6)", () => {
  test("each CurrencyStat carries decimals matching its currency (EUR=2 AND a non-2)", async () => {
    const op = await freshOperator(["EUR", "USDT", "BTC"]);
    const eur = await makePlayer(op.id, "dec-eur", "EUR");
    const usdt = await makePlayer(op.id, "dec-usdt", "USDT");
    const btc = await makePlayer(op.id, "dec-btc", "BTC");
    await seedBet(eur.walletId, eur.userId, { operatorId: op.id, amount: 1000n, status: "busted", currency: "EUR" });
    await seedBet(usdt.walletId, usdt.userId, { operatorId: op.id, amount: 2000n, status: "busted", currency: "USDT" });
    await seedBet(btc.walletId, btc.userId, { operatorId: op.id, amount: 3000n, status: "busted", currency: "BTC" });

    const res = await reporting.summary(op.id, Q());
    const byCcy = new Map(res.currencies.map((c) => [c.currency, c]));
    // The non-2 canaries prove decimals is the REAL per-currency precision, not a constant.
    expect(byCcy.get("EUR")!.decimals).toBe(2);
    expect(byCcy.get("USDT")!.decimals).toBe(6);
    expect(byCcy.get("BTC")!.decimals).toBe(8);
    // Every row has an integer decimals.
    for (const c of res.currencies) expect(Number.isInteger(c.decimals)).toBe(true);
  });

  test("daily buckets also carry per-currency decimals", async () => {
    const op = await freshOperator(["JPY"]);
    const p = await makePlayer(op.id, "dec-jpy", "JPY");
    await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 500n, status: "busted", currency: "JPY", createdAt: new Date("2026-06-07T10:00:00Z") });
    const res = await reporting.daily(op.id, parseDailyQuery({ from: "2026-06-07", to: "2026-06-07" }));
    expect(res.days.length).toBe(1);
    expect(res.days[0].currency).toBe("JPY");
    expect(res.days[0].decimals).toBe(0); // JPY canary: real 0-dp
  });

  test("each BetRow carries decimals for its currency", async () => {
    const op = await freshOperator(["EUR", "USDT"]);
    const eur = await makePlayer(op.id, "row-eur", "EUR");
    const usdt = await makePlayer(op.id, "row-usdt", "USDT");
    const eurBetId = await seedBet(eur.walletId, eur.userId, { operatorId: op.id, amount: 100n, status: "busted", currency: "EUR" });
    const usdtBetId = await seedBet(usdt.walletId, usdt.userId, { operatorId: op.id, amount: 200n, status: "busted", currency: "USDT" });

    const res = await reporting.bets(op.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString() }));
    const eurRow = res.bets.find((b) => b.id === eurBetId)!;
    const usdtRow = res.bets.find((b) => b.id === usdtBetId)!;
    expect(eurRow.currency).toBe("EUR");
    expect(eurRow.decimals).toBe(2);
    expect(usdtRow.currency).toBe("USDT");
    expect(usdtRow.decimals).toBe(6); // non-2 canary on a bet row
  });

  test("a bet with a NULL currency → decimals falls back to 2 (never throws)", async () => {
    // Bet.currency is nullable in the schema; a legacy/internal row with no stamped
    // currency must still produce a row with the 2-dp fallback, not a 500.
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "row-nullccy", "EUR");
    const roundId = await makeRound();
    const betId = randomUUID();
    await prisma.bet.create({
      data: {
        id: betId,
        roundId,
        userId: p.userId,
        walletId: p.walletId,
        panel: "A",
        amount: 100n,
        status: "busted",
        payout: 0n,
        demo: false,
        operatorId: op.id,
        currency: null, // explicitly unstamped
        settledAt: new Date(),
      },
    });
    const res = await reporting.bets(op.id, parseBetsQuery({ from: FROM.toISOString(), to: TO.toISOString() }));
    const row = res.bets.find((b) => b.id === betId)!;
    expect(row.currency).toBeNull();
    expect(row.decimals).toBe(2); // fallback for a null/unknown currency
  });
});
