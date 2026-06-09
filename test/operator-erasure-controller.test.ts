import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { AuditEventService } from "../src/audit/audit-event.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { DataErasureService } from "../src/privacy/data-erasure.service";
import { OperatorErasureController } from "../src/privacy/operator-erasure.controller";
import {
  OperatorAuthGuard,
  RequireWriteScope,
  OPERATOR_WRITE_SCOPE,
} from "../src/operator/operator-auth.guard";
import {
  generateReportingKey,
  generateWriteKey,
  REPORTING_TOKEN_PREFIX,
  WRITE_TOKEN_PREFIX,
} from "../src/operator/reporting-key";
import { makeAudit } from "./helpers/audit";

/**
 * GDPR + caps batch — OPERATOR-FACING ERASURE ROUTE (R-039).
 * `POST /api/operator/players/:playerId/erase` (src/privacy/operator-erasure.controller.ts).
 *
 * Two layers, both pinned here before the batch is committed:
 *
 *  A. CONTROLLER behaviour (DB-backed — real Users/GameSessions via the launch path, mirroring
 *     data-erasure.test.ts wiring): the operatorId comes ONLY from @CurrentOperatorId (the
 *     authenticated tenant), NEVER the path/body, so a path/body can't widen scope to another
 *     operator's player. We invoke the handler method directly with the resolved operatorId, the
 *     same value the guard would have set on req.operatorId.
 *       - cross-tenant erase (operator B asks to erase operator A's playerId) → 404
 *         `player_not_found`, NO existence oracle, and A's user is UNTOUCHED (not tombstoned);
 *       - own-player erase (settled) → 200 { ok, alreadyAnonymized:false, usersAffected:1 };
 *       - already-anonymized re-erase → 200 { alreadyAnonymized:true } (NOT a 404 — the resolver
 *         re-finds the tombstoned player by its sessions, so usersAffected>0);
 *       - a no-such-player id → the SAME 404 as cross-tenant (indistinguishable: no oracle);
 *       - a >256-char / empty / non-string path playerId → 400 invalid_player_id (before the
 *         service is touched).
 *
 *  B. WRITE-SCOPE GATE (the security boundary — the route carries @RequireWriteScope at the
 *     class level): the OperatorAuthGuard denies a READ key and fail-closes when writeApiKeyHash
 *     is null, EXACTLY like the bet-void route (mirrors operator-auth-guard.test.ts). We assert
 *     the controller class actually carries the OPERATOR_WRITE_SCOPE metadata (so it is wired into
 *     the gate) and drive the guard against that metadata.
 *
 * Needs docker Postgres. Child-first, FK-safe teardown by tracked ids (after anonymization the
 * username is `anon:` so the op: prefix sweep would miss it).
 */

const JWT_SECRET = "erasure-ctrl-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));
const metrics = new MetricsService();
const audit = new AuditEventService(prisma, metrics);
const erasure = new DataErasureService(prisma, audit, metrics);
const controller = new OperatorErasureController(erasure);

// The guard for the write-scope cases (same construction as operator-auth-guard.test.ts).
const guard = new OperatorAuthGuard(prisma, new Reflector());

const createdOperatorIds: string[] = [];
const createdWalletIds: string[] = [];
const createdUserIds: string[] = [];

async function freshOperator(opts: { readKey?: boolean; writeKey?: boolean } = {}) {
  const id = randomUUID();
  const read = generateReportingKey(id);
  const write = generateWriteKey(id);
  const op = await prisma.operator.create({
    data: {
      id,
      code: "op-erc-" + randomUUID().slice(0, 8),
      name: "Erasure-Ctrl Operator",
      enabled: true,
      demoEnabled: false,
      launchSecret: "secret-" + randomUUID(),
      currencies: ["EUR"],
      ...(opts.readKey === false ? {} : { reportingApiKeyHash: read.hash }),
      ...(opts.writeKey === false ? {} : { writeApiKeyHash: write.hash }),
    },
  });
  createdOperatorIds.push(op.id);
  return { op, readToken: read.token, writeToken: write.token };
}

/** Launch a REAL player under `operatorId`, returning the resolved user/wallet/session. */
async function launchPlayer(operatorId: string, playerId: string) {
  const token = await launch.issue({ operatorId, playerId, currency: "EUR" });
  const s = await sessions.openFromToken(token);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  createdWalletIds.push(s.walletId);
  createdUserIds.push(wallet.userId);
  return { playerId, walletId: s.walletId, userId: wallet.userId, sessionId: s.sessionId };
}

// Fake ExecutionContext exposing only what the guard reads (mirrors operator-auth-guard.test.ts).
function reqWith(authorization?: string): any {
  return { socket: { remoteAddress: "10.0.0.1" }, headers: { authorization } };
}
function writeCtx(req: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    // The real production controller class carries @RequireWriteScope at the class level — use it
    // so the Reflector reads back exactly what it does in production.
    getHandler: () => OperatorErasureController.prototype.erase,
    getClass: () => OperatorErasureController,
  };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Child-first teardown by tracked ids (post-anonymize username is `anon:`, not the op: tag).
  try {
    if (createdWalletIds.length) await prisma.bet.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdWalletIds.length) await prisma.ledgerTransaction.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdUserIds.length) await prisma.profile.deleteMany({ where: { userId: { in: createdUserIds } } });
    if (createdWalletIds.length) await prisma.wallet.deleteMany({ where: { id: { in: createdWalletIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("OperatorErasureController.erase — tenant scoping + idempotency (R-039)", () => {
  test("CROSS-TENANT: operator B erasing operator A's playerId → 404 player_not_found, NO oracle, A untouched", async () => {
    const { op: opA } = await freshOperator();
    const { op: opB } = await freshOperator();
    const shared = "shared-" + randomUUID().slice(0, 6);

    // A launches the player; B never did.
    const a = await launchPlayer(opA.id, shared);
    await sessions.revokeForWallet(a.walletId); // settle so a same-tenant erase WOULD succeed

    // B (the authenticated tenant) asks to erase A's playerId — resolves to 0 of B's users → 404.
    let crossErr: unknown;
    try {
      await controller.erase(opB.id, shared, {});
    } catch (e) {
      crossErr = e;
    }
    expect(crossErr).toBeInstanceOf(NotFoundException);
    expect((crossErr as NotFoundException).getStatus()).toBe(404);
    const body: any = (crossErr as NotFoundException).getResponse();
    expect(typeof body === "string" ? body : body.message).toBe("player_not_found");

    // A's user is UNTOUCHED — not tombstoned, op: tag intact.
    const aUser = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(aUser.username.startsWith("op:")).toBe(true);
    expect(aUser.anonymizedAt).toBeNull();
    // No audit row was written for B's cross-tenant 404 attempt.
    expect(await prisma.auditEvent.count({ where: { operatorId: opB.id, action: "player.anonymize" } })).toBe(0);

    // NO EXISTENCE ORACLE: a playerId that NEVER existed under B yields the SAME 404 + message.
    let ghostErr: unknown;
    try {
      await controller.erase(opB.id, "ghost-" + randomUUID().slice(0, 6), {});
    } catch (e) {
      ghostErr = e;
    }
    expect(ghostErr).toBeInstanceOf(NotFoundException);
    const ghostBody: any = (ghostErr as NotFoundException).getResponse();
    expect(typeof ghostBody === "string" ? ghostBody : ghostBody.message).toBe("player_not_found");
  });

  test("OWN player (settled) → 200 alreadyAnonymized:false, then a re-erase → 200 alreadyAnonymized:true (NOT 404)", async () => {
    const { op } = await freshOperator();
    const playerId = "own-" + randomUUID().slice(0, 6);
    const p = await launchPlayer(op.id, playerId);
    await sessions.revokeForWallet(p.walletId); // settle (no live session)

    // First erase — actually scrubs.
    const first = await controller.erase(op.id, playerId, { reason: "gdpr request" });
    expect(first.ok).toBe(true);
    expect(first.alreadyAnonymized).toBe(false);
    expect(first.usersAffected).toBe(1);
    expect(first.playerId).toBe(playerId);
    expect(first.scrubbedFields).toEqual(["username", "displayName", "session.playerId"]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    expect(user.username.startsWith("anon:")).toBe(true);
    expect(user.username.includes(playerId)).toBe(false);
    expect(user.anonymizedAt).not.toBeNull();

    // Re-erase the SAME (now-anonymized) player → idempotent 200, NOT a 404. The resolver
    // re-finds the tombstoned player by its sessions, so usersAffected>0 → reported as 200.
    const again = await controller.erase(op.id, playerId, {});
    expect(again.ok).toBe(true);
    expect(again.alreadyAnonymized).toBe(true);
    expect(again.usersAffected).toBe(1);
  });

  test("path playerId validation: >256 / empty / non-string → 400 invalid_player_id, service untouched", async () => {
    const { op } = await freshOperator();
    // Capturing fake so we can assert the service is NOT reached for a bad path id.
    let serviceCalls = 0;
    const spy: any = {
      anonymizePlayer: async () => {
        serviceCalls++;
        return { ok: true, alreadyAnonymized: false, usersAffected: 0, scrubbedFields: [] };
      },
    };
    const c = new OperatorErasureController(spy as DataErasureService);

    const bad: unknown[] = ["", "x".repeat(257), null, undefined, 123, {}];
    for (const id of bad) {
      let err: unknown;
      try {
        await c.erase(op.id, id as any, {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const body: any = (err as BadRequestException).getResponse();
      expect(typeof body === "string" ? body : body.message).toBe("invalid_player_id");
    }
    // A 256-char id is the boundary — accepted at the cap, reaches the service (0 users → 404).
    let boundaryErr: unknown;
    try {
      await c.erase(op.id, "y".repeat(256), {});
    } catch (e) {
      boundaryErr = e;
    }
    expect(boundaryErr).toBeInstanceOf(NotFoundException); // service ran, resolved 0 → 404
    expect(serviceCalls).toBe(1); // only the valid 256-char id reached the service
  });

  test("invalid body (bad shape) → 400 invalid_body, before the service", async () => {
    const { op } = await freshOperator();
    let serviceCalls = 0;
    const spy: any = { anonymizePlayer: async () => { serviceCalls++; return { ok: true, alreadyAnonymized: false, usersAffected: 0, scrubbedFields: [] }; } };
    const c = new OperatorErasureController(spy as DataErasureService);
    // currency must be a non-empty string ≤16; a 1000-char currency / non-string fails the zod schema.
    for (const body of [{ currency: "x".repeat(1000) }, { currency: 123 }, { reason: "z".repeat(501) }]) {
      let err: unknown;
      try {
        await c.erase(op.id, "p" + randomUUID().slice(0, 6), body);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const b: any = (err as BadRequestException).getResponse();
      expect(typeof b === "string" ? b : b.message).toBe("invalid_body");
    }
    expect(serviceCalls).toBe(0);
  });
});

describe("OperatorErasureController — WRITE-scope gate (mirrors bet-void: @RequireWriteScope)", () => {
  test("the controller class carries OPERATOR_WRITE_SCOPE metadata (wired into the gate)", () => {
    const reflector = new Reflector();
    expect(
      reflector.getAllAndOverride<boolean>(OPERATOR_WRITE_SCOPE, [
        OperatorErasureController.prototype.erase,
        OperatorErasureController,
      ]),
    ).toBe(true);
  });

  test("READ key on the (write-scoped) erase route → 401 invalid_api_key", async () => {
    const { readToken } = await freshOperator(); // has BOTH a read and a write key
    await expect(guard.canActivate(writeCtx(reqWith(`Bearer ${readToken}`)))).rejects.toMatchObject({
      message: "invalid_api_key",
    });
  });

  test("writeApiKeyHash IS NULL → erase route 401 (fail-closed, no write key provisioned)", async () => {
    const { op, writeToken } = await freshOperator({ writeKey: false });
    await expect(guard.canActivate(writeCtx(reqWith(`Bearer ${writeToken}`)))).rejects.toMatchObject({
      message: "invalid_api_key",
    });
    // A well-formed-but-unprovisioned write token for this operator also fails closed.
    const forged = `${WRITE_TOKEN_PREFIX}${op.id}.${"c".repeat(64)}`;
    await expect(guard.canActivate(writeCtx(reqWith(`Bearer ${forged}`)))).rejects.toMatchObject({
      message: "invalid_api_key",
    });
  });

  test("a READ secret RELABELED with the vrw_ prefix → 401 (scope is metadata-driven, not the prefix)", async () => {
    const { readToken } = await freshOperator();
    const relabeled = readToken.replace(REPORTING_TOKEN_PREFIX, WRITE_TOKEN_PREFIX);
    expect(relabeled.startsWith(WRITE_TOKEN_PREFIX)).toBe(true);
    await expect(guard.canActivate(writeCtx(reqWith(`Bearer ${relabeled}`)))).rejects.toMatchObject({
      message: "invalid_api_key",
    });
  });

  test("valid WRITE key on the erase route → passes + sets operatorId", async () => {
    const { op, writeToken } = await freshOperator();
    const req = reqWith(`Bearer ${writeToken}`);
    await expect(guard.canActivate(writeCtx(req))).resolves.toBe(true);
    expect(req.operatorId).toBe(op.id);
  });

  test("missing / non-Bearer authorization on the erase route → 401", async () => {
    for (const auth of [undefined, "", "Basic xyz", "vrw_x.y"]) {
      await expect(guard.canActivate(writeCtx(reqWith(auth)))).rejects.toThrow(UnauthorizedException);
    }
  });
});
