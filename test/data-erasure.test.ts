import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { WalletRouter } from "../src/wallet/wallet-router";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { AuditEventService } from "../src/audit/audit-event.service";
import { DataErasureService } from "../src/privacy/data-erasure.service";
import { MockOperator } from "./helpers/mock-operator";
import { makeAudit } from "./helpers/audit";

/**
 * Audit F-065 — GDPR ERASURE-AS-ANONYMIZATION (DataErasureService).
 *
 * The privacy-by-design complement to F-017 (money records are now RESTRICT — never
 * cascade-deleted). DataErasureService scrubs a player's PII fields IN PLACE — User.username
 * → `anon:{tombstone}`, Profile.displayName → "anon", GameSession.playerId → `anon:{tombstone}`,
 * User.anonymizedAt → now() — and leaves the ENTIRE money graph (wallet balance, ledger,
 * every Bet's amount/payout/status) byte-identical.
 *
 * Wiring mirrors operator (real-money) mode (same as operator-money-path-e2e): a REAL
 * non-demo player is launched, plays + SETTLES a busted bet and a cashed_out bet against an
 * in-process MockOperator, then is anonymized. Needs docker Postgres+Redis. Operator-side
 * money keeps its own book (no ledger rows), so reconcile is asserted via the reconcile-check
 * script (whole-DB internal book) PLUS the operator MockOperator balance conservation.
 *
 * Proves (9):
 *  (1) tombstoned — username/displayName/session.playerId all carry `anon:` and the original
 *      playerId appears in none of them;
 *  (2) anonymizedAt set;
 *  (3) every Bet + (any) Ledger count + exact amount/payout/status/balanceAfter identical;
 *  (4) reconcile-check RECONCILED (exit 0) AND operator book byte-identical before/after;
 *  (5) ONE new audit row action="player.anonymize", targetId=internal userId (NOT playerId),
 *      the original playerId/username/displayName appear NOWHERE in it, ip null, before
 *      lists the scrubbed field names;
 *  (6) idempotent re-run → alreadyAnonymized:true, unchanged, NO second audit row;
 *  (7) a DIFFERENT operator with the SAME playerId → 0 users (tenant isolation);
 *  (8) blocked when not settled (a live session OR an active bet → player_not_settled, scrub
 *      nothing);
 *  (9) a raw user.delete with bets/ledger → P2003 (F-017 guard, the reason we anonymize).
 */

const JWT_SECRET = "erasure-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

const operatorApi = new MockOperator();
const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver());
const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));

let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: liveMult, serverTime: Date.now() }),
  currentMultiplier: () => liveMult,
};
const bets = new BetsService(prisma, router, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const audit = new AuditEventService(prisma, metrics);
const erasure = new DataErasureService(prisma, audit, metrics);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
// Track journal users/wallets explicitly: after anonymization the username is `anon:…`
// (no longer the op: tag), so the op:-prefix sweep can't find them — clean by id instead.
const createdWalletIds: string[] = [];
const createdUserIds: string[] = [];

async function makeRound(status: string): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 6_700_000 + Math.floor(Math.random() * 1_000_000), commitHash: "er-" + randomUUID(), length: 2, salt: "er-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "er-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** Launch a REAL (non-demo) operator player + seed its operator-side balance. */
async function launchReal(opts: { playerId?: string; currency?: string; operatorBalance: number; operatorId?: string }) {
  const currency = opts.currency ?? "EUR";
  let operatorId = opts.operatorId;
  if (!operatorId) {
    const op = await prisma.operator.create({
      data: {
        code: "op-er-" + randomUUID().slice(0, 8),
        name: "Erasure Operator",
        enabled: true,
        demoEnabled: false,
        launchSecret: "secret-" + randomUUID(),
        currencies: [currency],
      },
    });
    createdOperatorIds.push(op.id);
    operatorId = op.id;
  }
  const playerId = opts.playerId ?? "p-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId, playerId, currency });
  const s = await sessions.openFromToken(token);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  operatorApi.seed(playerId, currency, opts.operatorBalance);
  createdWalletIds.push(s.walletId);
  createdUserIds.push(wallet.userId);
  return { operatorId, playerId, currency, walletId: s.walletId, userId: wallet.userId, sessionId: s.sessionId };
}

/** Place + BUST a bet for this player (terminal: busted). */
async function placeAndBust(userId: string, walletId: string): Promise<string> {
  phase = "betting";
  activeRoundId = await makeRound("betting");
  const placed = await bets.placeBet(userId, "A", 1000, undefined, walletId);
  expect(placed.ok).toBe(true);
  await bets.settleRound(activeRoundId); // marks the active bet busted
  return placed.betId!;
}

/** Place + CASH OUT a bet for this player (terminal: cashed_out, with a payout credit). */
async function placeAndCashOut(userId: string, walletId: string): Promise<string> {
  phase = "betting";
  activeRoundId = await makeRound("betting");
  const placed = await bets.placeBet(userId, "A", 1000, undefined, walletId);
  expect(placed.ok).toBe(true);
  phase = "running";
  liveMult = 2.0;
  await prisma.round.update({ where: { id: activeRoundId }, data: { status: "running" } });
  const cashed = await bets.cashOut(userId, "A");
  expect(cashed.ok).toBe(true);
  return placed.betId!;
}

/** Snapshot the money-bearing columns of a player's bets (for byte-identical assertions). */
async function moneySnapshot(walletId: string) {
  const betRows = await prisma.bet.findMany({ where: { walletId }, orderBy: { id: "asc" }, select: { id: true, amount: true, payout: true, status: true } });
  const ledgerRows = await prisma.ledgerTransaction.findMany({ where: { walletId }, orderBy: { id: "asc" }, select: { id: true, amount: true, balanceAfter: true, type: true } });
  return { betRows, ledgerRows };
}

/**
 * OPERATOR-BOOK reconciliation SCOPED to one player (the operator-mode analog of
 * scripts/reconcile-check.ts, which only audits the INTERNAL ledger book — operator bets
 * have NO ledger rows). Scoping to OUR wallet keeps this immune to other suites' residue on
 * the shared dev DB (the same reason operator-void.test.ts replicates the reconcile
 * invariants in-process scoped to its own wallet, rather than shelling out).
 *
 * Invariant: the operator balance == seed − Σ(stake over all this wallet's bets) + Σ(payout
 * over its cashed_out bets). Returns the operator balance + the two money sums so the caller
 * can assert RECONCILED and byte-identical before/after anonymization.
 */
async function reconcileOperatorBook(opts: {
  walletId: string;
  playerId: string;
  currency: string;
  seed: bigint;
}): Promise<{ reconciled: boolean; operatorBalance: bigint; stakeSum: bigint; paidPayoutSum: bigint }> {
  const stakeSum = (await prisma.bet.aggregate({ where: { walletId: opts.walletId }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const paidPayoutSum = (await prisma.bet.aggregate({ where: { walletId: opts.walletId, status: "cashed_out" }, _sum: { payout: true } }))._sum.payout ?? 0n;
  const operatorBalance = operatorApi.balanceOf(opts.playerId, opts.currency);
  const reconciled = operatorBalance === opts.seed - stakeSum + paidPayoutSum;
  return { reconciled, operatorBalance, stakeSum, paidPayoutSum };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Child-first teardown by TRACKED ids (not the op: tag): after anonymization the username
  // is `anon:…`, so an op:-prefix sweep would miss those users — clean by id instead.
  // Order: bets → ledger → rounds → seeds → chains → wallets → users → operators.
  try {
    if (createdWalletIds.length) await prisma.bet.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdWalletIds.length) await prisma.ledgerTransaction.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.profile.deleteMany({ where: { userId: { in: createdUserIds } } });
    if (createdWalletIds.length) await prisma.wallet.deleteMany({ where: { id: { in: createdWalletIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("F-065 GDPR erasure-as-anonymization (DataErasureService)", () => {
  test("settled real-money player is anonymized in place; money + reconcile intact; one clean audit row", async () => {
    const SEED = 100_000n;
    const { operatorId, playerId, walletId, userId, sessionId } = await launchReal({ operatorBalance: Number(SEED) });

    // SETTLE: one busted + one cashed_out bet (both terminal). The cashed_out leg pays out.
    const bustedBetId = await placeAndBust(userId, walletId);
    const cashedBetId = await placeAndCashOut(userId, walletId);

    // End the session so there is no live session blocking anonymization.
    await sessions.revokeForWallet(walletId);

    // Capture money + reconcile BEFORE.
    const before = await moneySnapshot(walletId);
    const reconBefore = await reconcileOperatorBook({ walletId, playerId, currency: "EUR", seed: SEED });
    expect(reconBefore.reconciled).toBe(true);

    // Audit rows for THIS operator before anonymizing (to prove exactly +1 after).
    const auditCountBefore = await prisma.auditEvent.count({ where: { operatorId, action: "player.anonymize" } });

    // ---- ANONYMIZE ----
    const result = await erasure.anonymizePlayer({ operatorId, playerId, currency: "EUR", actor: "provision-cli", reason: "gdpr erasure #1" });
    expect(result.ok).toBe(true);
    expect(result.alreadyAnonymized).toBe(false);
    expect(result.usersAffected).toBe(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId } });
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: sessionId } });

    // (1) tombstoned — anon: prefix everywhere, the original playerId appears in NONE of them.
    expect(user.username.startsWith("anon:")).toBe(true);
    expect(user.username.includes(playerId)).toBe(false);
    expect(profile.displayName).toBe("anon");
    expect(session.playerId.startsWith("anon:")).toBe(true);
    expect(session.playerId.includes(playerId)).toBe(false);

    // (2) anonymizedAt set.
    expect(user.anonymizedAt).not.toBeNull();

    // (3) every Bet + Ledger row identical (count + exact amount/payout/status/balanceAfter).
    const after = await moneySnapshot(walletId);
    expect(after.betRows).toEqual(before.betRows);
    expect(after.ledgerRows).toEqual(before.ledgerRows);
    // Both settled bets still present + terminal.
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: bustedBetId } })).status).toBe("busted");
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: cashedBetId } })).status).toBe("cashed_out");

    // (4) reconcile still RECONCILED + operator book byte-identical before/after.
    const reconAfter = await reconcileOperatorBook({ walletId, playerId, currency: "EUR", seed: SEED });
    expect(reconAfter.reconciled).toBe(true);
    expect(reconAfter.operatorBalance).toBe(reconBefore.operatorBalance);
    expect(reconAfter.stakeSum).toBe(reconBefore.stakeSum);
    expect(reconAfter.paidPayoutSum).toBe(reconBefore.paidPayoutSum);

    // (5) exactly ONE new audit row, clean.
    const auditRows = await prisma.auditEvent.findMany({ where: { operatorId, action: "player.anonymize" }, orderBy: { createdAt: "desc" } });
    expect(auditRows.length).toBe(auditCountBefore + 1);
    const row = auditRows[0];
    expect(row.targetType).toBe("user");
    expect(row.targetId).toBe(userId); // internal userId, NOT the operator playerId
    expect(row.targetId).not.toBe(playerId);
    expect(row.ip).toBeNull();
    // before.scrubbedFields lists the field NAMES that were scrubbed.
    expect((row.before as any)?.scrubbedFields).toEqual(["username", "displayName", "session.playerId"]);
    // The original playerId / pre-scrub username / displayName appear NOWHERE in the row.
    const haystack = JSON.stringify({ tid: row.targetId, before: row.before, after: row.after, meta: row.meta });
    expect(haystack.includes(playerId)).toBe(false);
    expect(haystack.includes(`op:${operatorId}:${playerId}`)).toBe(false);
    expect(haystack.toLowerCase().includes("player " + playerId.slice(0, 6).toLowerCase())).toBe(false);

    // (6) idempotent re-run → alreadyAnonymized, unchanged, NO second audit row.
    const again = await erasure.anonymizePlayer({ operatorId, playerId, currency: "EUR", actor: "provision-cli" });
    expect(again.alreadyAnonymized).toBe(true);
    expect(again.usersAffected).toBe(1);
    expect(await prisma.auditEvent.count({ where: { operatorId, action: "player.anonymize" } })).toBe(auditCountBefore + 1);
    const userAgain = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(userAgain.username).toBe(user.username); // unchanged tombstone
    expect((await moneySnapshot(walletId)).betRows).toEqual(before.betRows);
  });

  test("(7) tenant isolation — a different operator with the SAME playerId resolves 0 users", async () => {
    // Operator A launches playerId X (and we anonymize nothing here).
    const shared = "shared-" + randomUUID().slice(0, 6);
    const a = await launchReal({ playerId: shared, operatorBalance: 10_000 });
    // Operator B (a NEW operator) never launched playerId X.
    const b = await prisma.operator.create({
      data: { code: "op-er-" + randomUUID().slice(0, 8), name: "Other", enabled: true, demoEnabled: false, launchSecret: "s-" + randomUUID(), currencies: ["EUR"] },
    });
    createdOperatorIds.push(b.id);

    const r = await erasure.anonymizePlayer({ operatorId: b.id, playerId: shared, actor: "provision-cli" });
    expect(r.usersAffected).toBe(0);
    expect(r.alreadyAnonymized).toBe(false);
    // Operator A's user is untouched (not tombstoned).
    const aUser = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(aUser.username.startsWith("op:")).toBe(true);
    expect(aUser.anonymizedAt).toBeNull();
    // No audit row was written for B's no-op.
    expect(await prisma.auditEvent.count({ where: { operatorId: b.id, action: "player.anonymize" } })).toBe(0);
  });

  test("(8) blocked when not settled — a live session or an active bet → player_not_settled, nothing scrubbed", async () => {
    // Case A: a LIVE session (revokedAt null) blocks even with no open bet.
    const live = await launchReal({ operatorBalance: 50_000 });
    await expect(erasure.anonymizePlayer({ operatorId: live.operatorId, playerId: live.playerId, actor: "provision-cli" })).rejects.toThrow("player_not_settled");
    const liveUser = await prisma.user.findUniqueOrThrow({ where: { id: live.userId } });
    expect(liveUser.username.startsWith("op:")).toBe(true); // not scrubbed
    expect(liveUser.anonymizedAt).toBeNull();

    // Case B: session revoked, but an ACTIVE (non-terminal) bet is still in flight → blocked.
    const open = await launchReal({ operatorBalance: 50_000 });
    phase = "betting";
    activeRoundId = await makeRound("betting");
    const placed = await bets.placeBet(open.userId, "A", 1000, undefined, open.walletId);
    expect(placed.ok).toBe(true); // status: active (non-terminal)
    await sessions.revokeForWallet(open.walletId); // no live session now
    await expect(erasure.anonymizePlayer({ operatorId: open.operatorId, playerId: open.playerId, actor: "provision-cli" })).rejects.toThrow("player_not_settled");
    const openUser = await prisma.user.findUniqueOrThrow({ where: { id: open.userId } });
    expect(openUser.username.startsWith("op:")).toBe(true); // not scrubbed
    expect(openUser.anonymizedAt).toBeNull();
    // No audit row for either blocked attempt.
    expect(await prisma.auditEvent.count({ where: { operatorId: live.operatorId, action: "player.anonymize" } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { operatorId: open.operatorId, action: "player.anonymize" } })).toBe(0);
  });

  test("(10) DELIMITER GUARD: a colon-bearing playerId prefix does NOT over-match a sibling player", async () => {
    // `:` is the username field delimiter and playerId is not charset-validated, so player
    // "alice" (prefix `op:{op}:alice:`) is ALSO a prefix of player "alice:x:bob"
    // (username `op:{op}:alice:x:bob:EUR`). Anonymizing "alice" MUST scrub only alice — the
    // post-query suffix filter (remainder must be a bare currency [+:demo], no extra colons)
    // guards it. Both players live under the SAME operator; neither has an in-flight bet.
    const op = await prisma.operator.create({
      data: { code: "op-er-" + randomUUID().slice(0, 8), name: "Colon Guard", enabled: true, demoEnabled: false, launchSecret: "secret-" + randomUUID(), currencies: ["DEMO"] },
    });
    createdOperatorIds.push(op.id);

    // The target player and the colliding sibling, launched through the REAL username path
    // (game-session builds `op:{op}:{playerId}:{currency}` verbatim, so the colons flow in).
    const alice = await launchReal({ operatorId: op.id, playerId: "alice", currency: "DEMO", operatorBalance: 10_000 });
    const sibling = await launchReal({ operatorId: op.id, playerId: "alice:x:bob", currency: "DEMO", operatorBalance: 10_000 });

    // Sanity: the sibling's username really IS caught by the naive startsWith(prefix).
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } });
    const siblingUser = await prisma.user.findUniqueOrThrow({ where: { id: sibling.userId } });
    expect(aliceUser.username).toBe(`op:${op.id}:alice:DEMO`);
    expect(siblingUser.username).toBe(`op:${op.id}:alice:x:bob:DEMO`);
    expect(siblingUser.username.startsWith(`op:${op.id}:alice:`)).toBe(true); // the over-match the filter rejects

    // No in-flight bets here; just end the live sessions so the pre-condition passes.
    await sessions.revokeForWallet(alice.walletId);
    await sessions.revokeForWallet(sibling.walletId);

    const res = await erasure.anonymizePlayer({ operatorId: op.id, playerId: "alice", actor: "provision-cli", reason: "colon guard" });
    expect(res.ok).toBe(true);
    // ONLY alice was scrubbed — the colon-sibling is NOT collateral.
    expect(res.usersAffected).toBe(1);

    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } });
    const siblingAfter = await prisma.user.findUniqueOrThrow({ where: { id: sibling.userId } });
    const aliceProfile = await prisma.profile.findUniqueOrThrow({ where: { userId: alice.userId } });
    const siblingProfile = await prisma.profile.findUniqueOrThrow({ where: { userId: sibling.userId } });

    // alice scrubbed …
    expect(aliceAfter.username.startsWith("anon:")).toBe(true);
    expect(aliceAfter.anonymizedAt).not.toBeNull();
    expect(aliceProfile.displayName).toBe("anon");
    // … and the sibling UNCHANGED (username + displayName intact + not tombstoned).
    expect(siblingAfter.username).toBe(siblingUser.username);
    expect(siblingAfter.anonymizedAt).toBeNull();
    expect(siblingProfile.displayName).not.toBe("anon"); // displayName not scrubbed
  });

  test("(9) raw user.delete with bets/ledger is REJECTED (P2003) — the F-017 guard anonymize exists to satisfy", async () => {
    const { userId, walletId } = await launchReal({ operatorBalance: 50_000 });
    const betId = await placeAndBust(userId, walletId);
    expect(betId).toBeTruthy();

    let code: string | undefined;
    try {
      await prisma.user.delete({ where: { id: userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) code = e.code;
    }
    expect(code).toBe("P2003");
    // The user + its bet survive the refused delete.
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    expect(await prisma.bet.count({ where: { walletId } })).toBeGreaterThanOrEqual(1);
  });
});
