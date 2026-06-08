import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { FairnessService } from "../src/fairness/fairness.service";
import { DailySaltProvider } from "../src/fairness/salt.provider";
import { ReportingService } from "../src/operator/reporting.service";
import { AuditEventsController } from "../src/operator/audit-events.controller";
import { provisionOperator } from "../scripts/operator-provision";
import { parseReportingToken } from "../src/operator/reporting-key";
import { makeAudit } from "./helpers/audit";

/**
 * F-058 regression suite — the unified, APPEND-ONLY significant-event AUDIT LOG.
 *
 * The audit finding mandates FOUR properties; each describe block below maps to one:
 *
 *   P1 (A.* blocks)  Each sensitive action WRITES the right immutable row — operator
 *                    bet-void, session.revoke, RNG epoch commit/arm, the salt fallback,
 *                    and the provision/config/key-rotate CLI writer. Asserts the row's
 *                    action / actor / targetType / targetId / operatorId.
 *   P2 (B block)     NO secret ever lands in a written row — drive a real reporting-key
 *                    rotation + a walletApiKey set/clear through the provision writer,
 *                    then SCAN the persisted before/after/meta JSON for the actual
 *                    launchSecret / walletApiKey / reporting token+secret+hash and assert
 *                    only sanitized markers survive. (Public saltHash/commitHash allowed.)
 *   P3 (C block)     IMMUTABILITY — a normal app role CANNOT edit the log: update /
 *                    delete / deleteMany each REJECT at the DB trigger, and the row /
 *                    count is unchanged after the attempt.
 *   P4 (D block)     TENANT ISOLATION of GET /api/operator/audit-events — operator A sees
 *                    ONLY A's rows; B's rows + the system (operatorId null) rows are
 *                    invisible, and a query param cannot widen the scope.
 *
 * Wiring mirrors the sibling suites verbatim: a real PrismaService + a real
 * AuditEventService (via makeAudit) injected into BetsService / GameSessionService /
 * FairnessService (so record() actually lands rows in the test DB), and the
 * provisionOperator writer driven directly as operator-provision.test.ts does.
 *
 * ISOLATION DISCIPLINE (this is the shared dev DB):
 *  - All assertions are SCOPED to ids/operators/actions we create — never "the table
 *    is empty" (other suites write audit rows, and the immutability trigger FORBIDS
 *    deleting audit_events, so we can NOT clean them up). We tag every row we cause
 *    with an operatorId / targetId we generated, and read it back by that filter.
 *  - FK-safe teardown for the PLAY tables we touch (bets → rounds → seeds → chains;
 *    operator-tagged users; operators; fairness chains). audit_events are LEFT IN PLACE
 *    by design (append-only) — they carry our unique ids and never collide.
 */

const JWT_SECRET = "audit-events-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

const fakeEngine: any = {
  getPublicState: () => ({ roundId: "", phase: "betting", phaseEndsAt: Date.now() + 60_000, multiplier: 1, serverTime: Date.now() }),
  currentMultiplier: () => 1,
};
const betsLedger = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

// Read path under test (P4): the real controller → ReportingService → parseAuditQuery.
// We invoke the controller handler directly with the operatorId the OperatorAuthGuard's
// @CurrentOperatorId would inject — exactly as operator-void-controller.test.ts drives
// its controller and session-revocation.test.ts drives OperatorController.closeSession.
const reporting = new ReportingService(prisma);
const auditController = new AuditEventsController(reporting);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdUserIds: string[] = [];
const createdBetIds: string[] = [];
const createdOperatorCodes: string[] = [];
// Synthetic-only audit rows we INSERT directly for the immutability + isolation blocks
// (P3/P4). Cannot be deleted (trigger), so they carry unique ids and are read by filter.
const insertedAuditIds: string[] = [];

// Synthetic fairness epochs sit far above any real epoch so the read-only engine-fairness
// scan never touches them (same convention as operator-void / reporting suites).
async function makeRound(status = "crashed"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 7_900_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "audit-" + randomUUID(),
      length: 2,
      salt: "audit-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "audit-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A plain INTERNAL (operatorId:null) player + wallet. */
async function internalPlayer(balance: bigint) {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      username: "audit_int_" + id.slice(0, 10),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "a" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(user.id);
  return { userId: user.id, walletId: user.wallets[0].id };
}

const debitKey = (roundId: string, userId: string, panel: string) => `bet:${roundId}:${userId}:${panel}:debit`;
const payoutKey = (betId: string) => `bet:${betId}:payout`;

/** Seed a SETTLED internal bet WITH its real ledger rows (mirrors operator-void.test.ts
 *  settledInternalBet) so voidBet's reverse legs are meaningful. */
async function settledInternalBet(opts: {
  walletId: string;
  userId: string;
  status: "busted" | "cashed_out";
  stake: bigint;
  payout?: bigint;
  operatorId?: string | null;
}): Promise<{ betId: string }> {
  const roundId = await makeRound();
  const betId = randomUUID();
  await ledger.debit(opts.walletId, opts.stake, "bet_debit", debitKey(roundId, opts.userId, "A"), {
    refType: "bet",
    refId: betId,
  });
  const payout = opts.payout ?? 0n;
  let payoutTxId: string | null = null;
  if (opts.status === "cashed_out" && payout > 0n) {
    const tx = await ledger.credit(opts.walletId, payout, "payout_credit", payoutKey(betId), { refType: "bet", refId: betId });
    payoutTxId = tx.id;
  }
  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: "A",
      amount: opts.stake,
      status: opts.status,
      payout,
      operatorId: opts.operatorId ?? null,
      currency: "DEMO",
      ...(payoutTxId ? { payoutTxId, cashoutMult: 2.5 } : {}),
      settledAt: new Date(),
    },
  });
  createdBetIds.push(betId);
  return { betId };
}

/** Launch a real (non-demo) operator player → a live session (for session.revoke). */
async function launchRealPlayer(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-audit-" + randomUUID().slice(0, 8),
      name: "Audit Test Operator",
      enabled: true,
      demoEnabled: false,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  const playerId = "p-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId: op.id, playerId, currency });
  const session = await sessions.openFromToken(token);
  return { op, playerId, currency, session };
}

/** Read back the audit rows for one of OUR target ids (id-scoped — never table-wide). */
async function auditRowsForTarget(targetType: string, targetId: string) {
  return prisma.auditEvent.findMany({ where: { targetType, targetId }, orderBy: { createdAt: "asc" } });
}

/** Open a synthetic epoch via the (private) createEpoch under a TINY chain length so the
 *  audit-wiring tests (A.3/A.4) don't write/clean 10k seed rows each on the shared dev DB.
 *  Tracks the chain for FK-safe teardown; restores FAIRNESS_CHAIN_LENGTH after. */
async function openSyntheticEpoch(fairness: FairnessService): Promise<any> {
  const SAVED_LEN = process.env.FAIRNESS_CHAIN_LENGTH;
  process.env.FAIRNESS_CHAIN_LENGTH = "3"; // seeds [0,1,2] — enough to commit + arm
  try {
    const chain = await (fairness as any).createEpoch(true);
    if (chain) createdChainIds.push(chain.id);
    return chain;
  } finally {
    if (SAVED_LEN === undefined) delete process.env.FAIRNESS_CHAIN_LENGTH;
    else process.env.FAIRNESS_CHAIN_LENGTH = SAVED_LEN;
  }
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe teardown of the PLAY tables (bets → rounds → seeds → chains; operator-tagged
  // users; operators; plain users). audit_events are NEVER deleted (append-only trigger) —
  // they carry our unique ids and don't collide with anything.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    // FairnessSeed has NO onDelete:Cascade → delete seeds by chainId FIRST (covers both the
    // makeRound single-seed rounds AND the full seed chains created by createEpoch in A.3/A.4,
    // whose 10k seed ids we don't individually track), then the chains.
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: createdChainIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    // Resolve provision-created operator ids (by code) so we can sweep their journal users.
    const provOps = createdOperatorCodes.length
      ? await prisma.operator.findMany({ where: { code: { in: createdOperatorCodes } } })
      : [];
    const allOpIds = [...createdOperatorIds, ...provOps.map((o) => o.id)];
    for (const operatorId of allOpIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
    if (createdOperatorCodes.length) await prisma.operator.deleteMany({ where: { code: { in: createdOperatorCodes } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 — each sensitive action writes the RIGHT immutable row.
// ─────────────────────────────────────────────────────────────────────────────
describe("A.1 operator bet-void writes operator.bet_void", () => {
  test("voiding a settled bet appends exactly one operator.bet_void row (action/actor/target/operatorId)", async () => {
    const operatorId = randomUUID();
    const { userId, walletId } = await internalPlayer(10_000n);
    // A bet OWNED by this operator (so voidBet's tenant gate passes and the audit row
    // is stamped with this operatorId).
    const { betId } = await settledInternalBet({
      walletId, userId, status: "cashed_out", stake: 1000n, payout: 2500n, operatorId,
    });

    await betsLedger.voidBet(operatorId, betId, "fraud check");

    const rows = await auditRowsForTarget("bet", betId);
    expect(rows.length).toBe(1); // exactly one row for this void
    const row = rows[0];
    expect(row.action).toBe("operator.bet_void");
    expect(row.actor).toBe(`operator:${operatorId}`);
    expect(row.targetType).toBe("bet");
    expect(row.targetId).toBe(betId);
    expect(row.operatorId).toBe(operatorId);
    // before/after capture the status transition; meta carries the reason + figures.
    expect((row.before as any).status).toBe("cashed_out");
    expect((row.after as any).status).toBe("voided");
    expect((row.meta as any).reason).toBe("fraud check");
    expect((row.meta as any).refundedStake).toBe("1000");
    expect((row.meta as any).reclaimedPayout).toBe("2500");
  });

  test("an idempotent re-void (reversed:false) does NOT append a second row", async () => {
    const operatorId = randomUUID();
    const { userId, walletId } = await internalPlayer(10_000n);
    const { betId } = await settledInternalBet({ walletId, userId, status: "busted", stake: 1000n, operatorId });

    await betsLedger.voidBet(operatorId, betId); // does the work → 1 row
    await betsLedger.voidBet(operatorId, betId); // idempotent no-op → no new row

    const rows = await auditRowsForTarget("bet", betId);
    expect(rows.length).toBe(1); // the no-op void short-circuits BEFORE record()
    expect(rows[0].action).toBe("operator.bet_void");
  });
});

describe("A.2 session revoke writes session.revoke", () => {
  test("revokeForWallet appends a session.revoke row stamped with the session's operatorId", async () => {
    const { op, session } = await launchRealPlayer("EUR");
    const revoked = await sessions.revokeForWallet(session.walletId);
    expect(revoked).toBe(1);

    const rows = await auditRowsForTarget("game_session", session.walletId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.action).toBe("session.revoke");
    expect(row.actor).toBe("system");
    expect(row.targetType).toBe("game_session");
    expect(row.targetId).toBe(session.walletId);
    expect(row.operatorId).toBe(op.id); // captured from the revoked session
    expect((row.meta as any).walletId).toBe(session.walletId);
    expect((row.meta as any).revokedCount).toBe(1);
    expect((row.meta as any).sessionIds).toContain(session.sessionId);
  });

  test("an already-revoked (idempotent count 0) revoke does NOT append a row", async () => {
    const { session } = await launchRealPlayer("EUR");
    expect(await sessions.revokeForWallet(session.walletId)).toBe(1); // 1 row
    expect(await sessions.revokeForWallet(session.walletId)).toBe(0); // no-op → no row

    const rows = await auditRowsForTarget("game_session", session.walletId);
    expect(rows.length).toBe(1); // only the first revoke logged
  });
});

describe("A.3 RNG epoch commit + arm write rng.epoch_commit / rng.salt_armed", () => {
  test("opening a random-salt epoch appends rng.epoch_commit AND rng.salt_armed for that epoch", async () => {
    // Drive the private createEpoch directly (unit-level) so this does NOT depend on the
    // shared DB's existing active epoch — ensureChain() would short-circuit when one
    // exists and never reach createEpoch. A DailySaltProvider returns a known salt
    // immediately → status "active" → both epoch_commit + salt_armed fire.
    const fairness = new FairnessService(prisma, new DailySaltProvider(), makeAudit(prisma));
    const chain = await openSyntheticEpoch(fairness);
    expect(chain).not.toBeNull();
    const epoch = String(chain.epoch);

    const rows = await auditRowsForTarget("rng_epoch", epoch);
    const byAction = new Map(rows.map((r) => [r.action, r]));
    expect(byAction.has("rng.epoch_commit")).toBe(true);
    expect(byAction.has("rng.salt_armed")).toBe(true);

    const commit = byAction.get("rng.epoch_commit")!;
    expect(commit.actor).toBe("system");
    expect(commit.targetType).toBe("rng_epoch");
    expect(commit.targetId).toBe(epoch);
    expect(commit.operatorId).toBeNull(); // a system event, not operator-scoped
    expect((commit.meta as any).saltSource).toBe("random");
    expect((commit.meta as any).commitHash).toBe(chain.commitHash); // public artifact, kept

    const armed = byAction.get("rng.salt_armed")!;
    expect(armed.actor).toBe("system");
    expect(typeof (armed.meta as any).saltHash).toBe("string"); // public salt-hash, kept
  });
});

describe("A.4 RNG salt fallback writes rng.salt_fallback", () => {
  test("when the primary salt provider throws, the random fallback epoch logs rng.salt_fallback", async () => {
    // A provider whose commit() rejects → createEpoch (non-strict) catches it, sets
    // fallback={reason:'commit_failed'}, falls back to the internal random provider, and
    // emits epoch_commit + salt_fallback + salt_armed for the epoch. FAIRNESS_REQUIRE_BLOCK_SALT
    // must be falsy here (default) so the random fallback is allowed.
    const SAVED = process.env.FAIRNESS_REQUIRE_BLOCK_SALT;
    delete process.env.FAIRNESS_REQUIRE_BLOCK_SALT;
    try {
      class ThrowingSaltProvider {
        async commit(): Promise<never> {
          throw new Error("oracle_unreachable");
        }
        async resolve(): Promise<string | null> {
          return null;
        }
      }
      const fairness = new FairnessService(prisma, new ThrowingSaltProvider() as any, makeAudit(prisma));
      const chain = await openSyntheticEpoch(fairness);
      expect(chain).not.toBeNull();
      const epoch = String(chain.epoch);

      const rows = await auditRowsForTarget("rng_epoch", epoch);
      const byAction = new Map(rows.map((r) => [r.action, r]));
      expect(byAction.has("rng.salt_fallback")).toBe(true);
      expect(byAction.has("rng.epoch_commit")).toBe(true); // the epoch still commits

      const fb = byAction.get("rng.salt_fallback")!;
      expect(fb.actor).toBe("system");
      expect(fb.targetType).toBe("rng_epoch");
      expect(fb.targetId).toBe(epoch);
      expect((fb.meta as any).reason).toBe("commit_failed");
      expect((fb.meta as any).fellBackFrom).toBe("ThrowingSaltProvider");
      expect((fb.meta as any).saltSource).toBe("random"); // landed on the random net
    } finally {
      if (SAVED === undefined) delete process.env.FAIRNESS_REQUIRE_BLOCK_SALT;
      else process.env.FAIRNESS_REQUIRE_BLOCK_SALT = SAVED;
    }
  });
});

describe("A.5 provision CLI writes operator.provision / config_update / reporting_key.rotate", () => {
  test("create → operator.provision; update → operator.config_update; reporting-key rotate → reporting_key.rotate", async () => {
    const SAVED_PEPPER = process.env.REPORTING_KEY_PEPPER;
    delete process.env.REPORTING_KEY_PEPPER; // deterministic sha256 hash mode
    try {
      const code = "prov-audit-" + randomUUID().slice(0, 8);
      createdOperatorCodes.push(code);

      // CREATE → operator.provision
      const created = await provisionOperator(prisma, { code, name: "Prov Audit", currencies: ["EUR"] });
      const opId = created.operator.id;

      // UPDATE → operator.config_update
      await provisionOperator(prisma, { code, name: "Prov Audit Renamed", currencies: ["EUR", "USD"] });

      // ROTATE REPORTING KEY → reporting_key.rotate
      await provisionOperator(prisma, { code, rotateReportingKey: true });

      const rows = await auditRowsForTarget("operator", opId);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain("operator.provision");
      expect(actions).toContain("operator.config_update");
      expect(actions).toContain("reporting_key.rotate");

      // The provision-CLI rows are stamped actor=provision-cli and the operator id.
      for (const r of rows) {
        expect(r.actor).toBe("provision-cli");
        expect(r.targetType).toBe("operator");
        expect(r.operatorId).toBe(opId);
      }
      const rotate = rows.find((r) => r.action === "reporting_key.rotate")!;
      // Only the self-describing algo prefix is recorded — never the token/hash.
      expect((rotate.meta as any).hashPrefix).toBe("sha256:");
    } finally {
      if (SAVED_PEPPER === undefined) delete process.env.REPORTING_KEY_PEPPER;
      else process.env.REPORTING_KEY_PEPPER = SAVED_PEPPER;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — NO secret in any written row (end-to-end through the provision writer).
// ─────────────────────────────────────────────────────────────────────────────
describe("B no secret value lands in any audit row (end-to-end)", () => {
  // The literal secrets we feed in; NONE may appear verbatim in any persisted JSON.
  const WALLET_KEY = "WALLET-API-KEY-" + randomUUID().replace(/-/g, "");
  const HEX64_RE = /\b[0-9a-f]{64}\b/i; // a launchSecret (32-byte hex) or a sha256 hex digest

  test("provision + config + key-rotation: launchSecret / walletApiKey / reporting token+secret+hash never appear", async () => {
    const SAVED_PEPPER = process.env.REPORTING_KEY_PEPPER;
    delete process.env.REPORTING_KEY_PEPPER;
    try {
      const code = "prov-secret-" + randomUUID().slice(0, 8);
      createdOperatorCodes.push(code);

      // CREATE with a real walletApiKey set (operator.provision row records walletApiSet).
      const created = await provisionOperator(prisma, {
        code,
        name: "Secret Audit",
        currencies: ["EUR"],
        walletApiUrl: "https://op.example/wallet",
        walletApiKey: WALLET_KEY,
      });
      const opId = created.operator.id;
      const launchSecret = created.launchSecret!; // 32-byte hex, generated on create

      // UPDATE that ROTATES the launchSecret AND sets the walletApiKey again
      // (operator.config_update → must scrub both to markers).
      const rotated = await provisionOperator(prisma, {
        code,
        rotateSecret: true,
        walletApiKey: WALLET_KEY,
      });
      const rotatedLaunchSecret = rotated.launchSecret!;

      // UPDATE that CLEARS the walletApiKey (→ "(cleared)").
      await provisionOperator(prisma, { code, walletApiKey: "" });

      // ROTATE the reporting key (reporting_key.rotate → only a hash prefix logged).
      const keyRes = await provisionOperator(prisma, { code, rotateReportingKey: true });
      const reportingToken = keyRes.reportingApiKey!; // vrk_<opid>.<secret>, shown once
      const reportingSecret = parseReportingToken(reportingToken)!.secret;
      // The stored hash (never logged) — assert its literal value is absent too.
      const storedHash = (await prisma.operator.findUniqueOrThrow({ where: { code } })).reportingApiKeyHash!;

      // ---- Read back EVERY audit row for this operator and scan the serialized JSON ----
      const rows = await prisma.auditEvent.findMany({ where: { operatorId: opId } });
      expect(rows.length).toBeGreaterThanOrEqual(4); // provision + 3 updates (+ the rotate row)

      const secrets = [launchSecret, rotatedLaunchSecret, WALLET_KEY, reportingToken, reportingSecret, storedHash];
      for (const r of rows) {
        const blob = JSON.stringify({ before: r.before, after: r.after, meta: r.meta });
        for (const secret of secrets) {
          expect(blob.includes(secret)).toBe(false); // no literal secret value
        }
        // Belt-and-braces: no 64-hex token/digest smuggled anywhere in before/after.
        // (meta on reporting_key.rotate intentionally carries the algo PREFIX "sha256:"
        //  only — never the 64-hex digest — so a bare hex64 in before/after is a leak.)
        const beforeAfter = JSON.stringify({ before: r.before, after: r.after });
        expect(HEX64_RE.test(beforeAfter)).toBe(false);
      }

      // ---- And assert the POSITIVE markers ARE present (the field was visibly recorded) ----
      const byAction = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byAction.get(r.action) ?? [];
        list.push(r);
        byAction.set(r.action, list);
      }
      // config_update with rotateSecret → after.launchSecretRotated:true (NOT the secret).
      const updates = byAction.get("operator.config_update") ?? [];
      const rotatedRow = updates.find((r) => (r.after as any)?.launchSecretRotated === true);
      expect(rotatedRow).toBeTruthy();
      expect((rotatedRow!.after as any).launchSecret).toBeUndefined(); // key removed, not redacted-in-place
      // walletApiKey appears only as the marker "(set)" / "(cleared)".
      const walletSetRow = updates.find((r) => (r.after as any)?.walletApiKey === "(set)");
      const walletClearedRow = updates.find((r) => (r.after as any)?.walletApiKey === "(cleared)");
      expect(walletSetRow).toBeTruthy();
      expect(walletClearedRow).toBeTruthy();
      // The CREATE row records walletApiSet:true (a boolean), never the key.
      const provisionRow = (byAction.get("operator.provision") ?? [])[0];
      expect((provisionRow.after as any).walletApiSet).toBe(true);
      // reporting_key.rotate records ONLY the algo prefix.
      const rotateRow = (byAction.get("reporting_key.rotate") ?? [])[0];
      expect((rotateRow.meta as any).hashPrefix).toBe("sha256:");
    } finally {
      if (SAVED_PEPPER === undefined) delete process.env.REPORTING_KEY_PEPPER;
      else process.env.REPORTING_KEY_PEPPER = SAVED_PEPPER;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 — immutability: a normal app role cannot edit the log (DB trigger enforced).
// ─────────────────────────────────────────────────────────────────────────────
describe("C immutability — update / delete / deleteMany are rejected by the DB trigger", () => {
  test("update / delete / deleteMany each REJECT with 'append-only ... forbidden'; the row survives", async () => {
    // Insert ONE row we can attempt to mutate (INSERT is the only allowed op).
    const id = randomUUID();
    const operatorId = randomUUID();
    const row = await prisma.auditEvent.create({
      data: {
        id,
        actor: "system",
        action: "test.immutability",
        targetType: "rng_epoch",
        targetId: "immutability-" + id,
        operatorId,
        meta: { probe: true },
      },
    });
    insertedAuditIds.push(row.id);

    // Prisma's *Promise is a lazy thenable, not a real Promise — wrap each call so the
    // `rejects` matcher receives a genuine awaited Promise (bun rejects a bare PrismaPromise).
    const RX = /append-only.*forbidden/;

    // 1) UPDATE → rejected by audit_events_no_update.
    await expect(
      (async () => prisma.auditEvent.update({ where: { id }, data: { actor: "tampered" } }))(),
    ).rejects.toThrow(RX);

    // 2) DELETE (single) → rejected by audit_events_no_delete.
    await expect((async () => prisma.auditEvent.delete({ where: { id } }))()).rejects.toThrow(RX);

    // 3) deleteMany scoped to JUST this row → still rejected (the trigger is per-row, and
    //    fires before any row is removed → nothing is deleted).
    await expect((async () => prisma.auditEvent.deleteMany({ where: { id } }))()).rejects.toThrow(RX);

    // The row is byte-for-byte intact after all three rejected attempts.
    const after = await prisma.auditEvent.findUniqueOrThrow({ where: { id } });
    expect(after.actor).toBe("system"); // NOT "tampered"
    expect(after.action).toBe("test.immutability");
    expect((after.meta as any).probe).toBe(true);
  });

  test("a TRUNCATE of audit_events is rejected (append-only, statement-level trigger)", async () => {
    // Belt-and-braces: the third trigger blocks TRUNCATE too. Use a raw statement (Prisma
    // has no truncate API). Scoped to assert the EXCEPTION — it never removes any data.
    await expect((async () => prisma.$executeRawUnsafe(`TRUNCATE TABLE "audit_events"`))()).rejects.toThrow(
      /append-only.*forbidden/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — tenant isolation of GET /api/operator/audit-events.
// ─────────────────────────────────────────────────────────────────────────────
describe("D read endpoint is hard-scoped to the authenticated operator", () => {
  // Three operators' worth of rows: A, B, and a system (operatorId null) row, all tagged
  // with a unique action so we can assert presence/absence precisely on the shared DB.
  const opA = randomUUID();
  const opB = randomUUID();
  const TAG = "test.isolation_" + randomUUID().slice(0, 8).replace(/-/g, "");
  const actionA = `${TAG}.a`.toLowerCase();
  const actionB = `${TAG}.b`.toLowerCase();
  const actionSys = `${TAG}.sys`.toLowerCase();

  beforeAll(async () => {
    for (const [operatorId, action, n] of [
      [opA, actionA, 3],
      [opB, actionB, 2],
      [null, actionSys, 2],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const r = await prisma.auditEvent.create({
          data: {
            actor: operatorId ? `operator:${operatorId}` : "system",
            action,
            targetType: "operator",
            targetId: `${action}-${i}`,
            operatorId: operatorId ?? undefined,
            meta: { i },
          },
        });
        insertedAuditIds.push(r.id);
      }
    }
  });

  test("operator A sees ONLY A's rows — none of B's, none of the system (null) rows", async () => {
    // No filter → all of A's audit rows (limit-capped). Drive the real controller as the
    // guard would: operatorId is the @CurrentOperatorId, query is the raw req query.
    const res: any = await auditController.list(opA, { limit: "200" });
    expect(res.operatorId).toBe(opA);
    const actions = new Set(res.events.map((e: any) => e.action));
    expect(actions.has(actionA)).toBe(true); // A's own rows present
    expect(actions.has(actionB)).toBe(false); // B's rows invisible
    expect(actions.has(actionSys)).toBe(false); // system/null rows invisible
    // Every returned row is operator A's (no foreign operatorId leaks via the body).
    for (const e of res.events) expect(e.targetId.startsWith(`${actionA}-`) || !e.action.startsWith(TAG)).toBe(true);
    // Exactly our 3 A-rows carry the A tag.
    expect(res.events.filter((e: any) => e.action === actionA).length).toBe(3);
  });

  test("operator B sees ONLY B's rows (symmetry)", async () => {
    const res: any = await auditController.list(opB, { limit: "200" });
    const actions = new Set(res.events.map((e: any) => e.action));
    expect(actions.has(actionB)).toBe(true);
    expect(actions.has(actionA)).toBe(false);
    expect(actions.has(actionSys)).toBe(false);
    expect(res.events.filter((e: any) => e.action === actionB).length).toBe(2);
  });

  test("an action filter cannot reach across tenants: A filtering on B's action gets nothing", async () => {
    // The operatorId comes ONLY from @CurrentOperatorId; action is an AND filter on top.
    const res: any = await auditController.list(opA, { action: actionB, limit: "200" });
    expect(res.events.length).toBe(0); // A + B's-action → empty (no cross-tenant reach)
  });

  test("a stray operatorId query param does NOT widen scope (it is ignored; guard wins)", async () => {
    // parseAuditQuery never reads operatorId; even if a caller smuggles one, the route
    // hard-scopes to @CurrentOperatorId. A (with ?operatorId=B) still sees only A.
    const res: any = await auditController.list(opA, { operatorId: opB, action: actionB, limit: "200" } as any);
    expect(res.operatorId).toBe(opA); // scope is A, not the param
    expect(res.events.length).toBe(0); // B's rows remain invisible
  });

  test("the system (operatorId null) rows are not visible to ANY operator", async () => {
    // Neither A nor B can ever surface the system rows.
    for (const op of [opA, opB]) {
      const res: any = await auditController.list(op, { action: actionSys, limit: "200" });
      expect(res.events.length).toBe(0);
    }
  });
});
