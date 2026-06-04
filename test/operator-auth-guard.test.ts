import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { OperatorAuthGuard } from "../src/operator/operator-auth.guard";
import { generateReportingKey, REPORTING_TOKEN_PREFIX } from "../src/operator/reporting-key";

/**
 * Phase 3.5 — OperatorAuthGuard (DB-backed). Authenticates a B2B reporting request
 * via the per-operator reporting key (Authorization: Bearer vrk_<operatorId>.<secret>)
 * and attaches req.operatorId — the tenant scope for every reporting query.
 *
 * Invariants:
 *  - a valid key for an enabled operator → canActivate true + sets req.operatorId;
 *  - missing / non-Bearer / malformed / wrong-secret → UnauthorizedException;
 *  - reportingApiKeyHash=null → 401 (no reporting access provisioned);
 *  - disabled operator (enabled:false) with a VALID key → 401 (operator_disabled);
 *  - rotated key: the OLD token fails, the NEW token passes (re-mint invalidates);
 *  - ipWhitelist: IP not in the list → 401; in the list → pass; empty list → skip.
 *
 * The guard never trusts an operatorId from the query/body — only the key prefix.
 */

const prisma = new PrismaService();
const guard = new OperatorAuthGuard(prisma);

// REPORTING_KEY_PEPPER is read at hash time and the bun process is shared — keep
// this suite running with NO pepper so its mints/verifies are self-consistent.
const SAVED_PEPPER = process.env.REPORTING_KEY_PEPPER;
beforeAll(async () => {
  delete process.env.REPORTING_KEY_PEPPER;
  await prisma.$connect();
});
afterEach(() => {
  if (SAVED_PEPPER === undefined) delete process.env.REPORTING_KEY_PEPPER;
  else process.env.REPORTING_KEY_PEPPER = SAVED_PEPPER;
});

const createdOperatorIds: string[] = [];
afterAll(async () => {
  try {
    if (createdOperatorIds.length)
      await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

/** Create an operator with a freshly minted reporting key; returns row + plaintext token. */
async function freshOperatorWithKey(
  opts: { enabled?: boolean; ipWhitelist?: string[]; withKey?: boolean } = {},
) {
  const id = randomUUID();
  const { token, hash } = generateReportingKey(id);
  const op = await prisma.operator.create({
    data: {
      id,
      code: "op-guard-" + randomUUID().slice(0, 8),
      name: "Guard Operator",
      enabled: opts.enabled ?? true,
      launchSecret: "secret-" + randomUUID(),
      currencies: ["EUR"],
      ipWhitelist: opts.ipWhitelist ?? [],
      ...(opts.withKey === false ? {} : { reportingApiKeyHash: hash }),
    },
  });
  createdOperatorIds.push(op.id);
  return { op, token };
}

// Fake ExecutionContext exposing what the guard touches: headers.authorization,
// headers (for client-ip), socket.remoteAddress, ip.
function ctxWith(req: any): any {
  return { switchToHttp: () => ({ getRequest: () => req }) };
}
function reqWith(authorization?: string, extra: { headers?: Record<string, unknown> } = {}): any {
  const { headers: extraHeaders, ...rest } = extra as Record<string, unknown>;
  return {
    socket: { remoteAddress: "10.0.0.1" },
    ...rest,
    // Merge headers LAST so authorization survives any caller-supplied headers.
    headers: { authorization, ...((extraHeaders as object) ?? {}) },
  };
}

describe("OperatorAuthGuard: success", () => {
  test("valid key for an enabled operator → true + sets req.operatorId", async () => {
    const { op, token } = await freshOperatorWithKey();
    const req = reqWith(`Bearer ${token}`);
    await expect(guard.canActivate(ctxWith(req))).resolves.toBe(true);
    // The guard sets req.operatorId — exactly what @CurrentOperatorId reads back.
    expect(req.operatorId).toBe(op.id);
    expect(ctxWith(req).switchToHttp().getRequest().operatorId).toBe(op.id);
  });
});

describe("OperatorAuthGuard: auth failures → UnauthorizedException", () => {
  // Header-shape rejections that never touch the DB.
  const headerRejects: Array<[string, string | undefined]> = [
    ["missing header", undefined],
    ["empty header", ""],
    ["non-Bearer scheme", "Basic vrk_x.y"],
    ["raw token, no scheme", "vrk_x.y"],
    ["Bearer with empty token", "Bearer "],
    ["malformed (no dot)", `Bearer ${REPORTING_TOKEN_PREFIX}11111111-1111-1111-1111-111111111111secret`],
    ["malformed (non-UUID id)", `Bearer ${REPORTING_TOKEN_PREFIX}not-a-uuid.secret`],
    ["wrong token prefix", "Bearer xyz_11111111-1111-1111-1111-111111111111.secret"],
  ];
  for (const [label, authorization] of headerRejects) {
    test(`${label} → 401`, async () => {
      await expect(guard.canActivate(ctxWith(reqWith(authorization)))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  }

  test("valid-shaped token but operator does not exist → 401", async () => {
    // A well-formed vrk_ token for a random (non-existent) operatorId.
    const { token } = generateReportingKey(randomUUID());
    await expect(guard.canActivate(ctxWith(reqWith(`Bearer ${token}`)))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  test("correct operatorId prefix but WRONG secret → 401", async () => {
    const { op } = await freshOperatorWithKey();
    // Same operator id, a different (well-formed) secret.
    const forged = `${REPORTING_TOKEN_PREFIX}${op.id}.${"a".repeat(64)}`;
    await expect(guard.canActivate(ctxWith(reqWith(`Bearer ${forged}`)))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  test("operator with reportingApiKeyHash=null → 401 even with a vrk_<id> token", async () => {
    const { op } = await freshOperatorWithKey({ withKey: false });
    const forged = `${REPORTING_TOKEN_PREFIX}${op.id}.${"b".repeat(64)}`;
    await expect(guard.canActivate(ctxWith(reqWith(`Bearer ${forged}`)))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  test("DISABLED operator with a VALID key → 401 (operator_disabled)", async () => {
    const { token } = await freshOperatorWithKey({ enabled: false });
    await expect(
      guard.canActivate(ctxWith(reqWith(`Bearer ${token}`))),
    ).rejects.toMatchObject({ message: "operator_disabled" });
  });
});

describe("OperatorAuthGuard: key rotation", () => {
  test("after rotation, the OLD token fails and the NEW token passes", async () => {
    const { op, token: oldToken } = await freshOperatorWithKey();
    // Old token works initially.
    await expect(guard.canActivate(ctxWith(reqWith(`Bearer ${oldToken}`)))).resolves.toBe(true);

    // Rotate: mint a new key for the SAME operator id, persist its hash.
    const { token: newToken, hash: newHash } = generateReportingKey(op.id);
    await prisma.operator.update({ where: { id: op.id }, data: { reportingApiKeyHash: newHash } });

    // Old token now rejected, new token accepted.
    await expect(guard.canActivate(ctxWith(reqWith(`Bearer ${oldToken}`)))).rejects.toThrow(
      UnauthorizedException,
    );
    const req = reqWith(`Bearer ${newToken}`);
    await expect(guard.canActivate(ctxWith(req))).resolves.toBe(true);
    expect(req.operatorId).toBe(op.id);
  });
});

describe("OperatorAuthGuard: ipWhitelist second factor", () => {
  test("IP not in a non-empty whitelist → 401 (ip_not_allowed)", async () => {
    const { token } = await freshOperatorWithKey({ ipWhitelist: ["203.0.113.7"] });
    // Caller IP comes from cf-connecting-ip (trusted edge header).
    const req = reqWith(`Bearer ${token}`, { headers: { "cf-connecting-ip": "198.51.100.4" } });
    await expect(guard.canActivate(ctxWith(req))).rejects.toMatchObject({ message: "ip_not_allowed" });
  });

  test("IP in the whitelist → pass + sets operatorId", async () => {
    const { op, token } = await freshOperatorWithKey({ ipWhitelist: ["203.0.113.7", "203.0.113.8"] });
    const req = reqWith(`Bearer ${token}`, { headers: { "cf-connecting-ip": "203.0.113.8" } });
    await expect(guard.canActivate(ctxWith(req))).resolves.toBe(true);
    expect(req.operatorId).toBe(op.id);
  });

  test("empty whitelist → IP check SKIPPED (back-compat), any IP passes", async () => {
    const { op, token } = await freshOperatorWithKey({ ipWhitelist: [] });
    const req = reqWith(`Bearer ${token}`, { headers: { "cf-connecting-ip": "8.8.8.8" } });
    await expect(guard.canActivate(ctxWith(req))).resolves.toBe(true);
    expect(req.operatorId).toBe(op.id);
  });
});
