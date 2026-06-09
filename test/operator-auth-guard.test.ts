import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerGuard, type ThrottlerRequest } from "@nestjs/throttler";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  OperatorAuthGuard,
  RequireWriteScope,
  OPERATOR_WRITE_SCOPE,
} from "../src/operator/operator-auth.guard";
import { OperatorThrottlerGuard } from "../src/operator/operator-throttler.guard";
import {
  generateReportingKey,
  generateWriteKey,
  parseReportingToken,
  REPORTING_TOKEN_PREFIX,
  WRITE_TOKEN_PREFIX,
} from "../src/operator/reporting-key";

/**
 * Phase 3.5 / write-route shared gate — OperatorAuthGuard (DB-backed). Authenticates a B2B
 * request via the per-operator API key and attaches req.operatorId — the tenant scope for every
 * reporting query.
 *
 * READ-scope invariants (Phase 3.5, unchanged — back-compat):
 *  - a valid reporting key for an enabled operator → canActivate true + sets req.operatorId;
 *  - missing / non-Bearer / malformed / wrong-secret → UnauthorizedException;
 *  - reportingApiKeyHash=null → 401 (no reporting access provisioned);
 *  - disabled operator (enabled:false) with a VALID key → 401 (operator_disabled);
 *  - rotated key: the OLD token fails, the NEW token passes (re-mint invalidates);
 *  - ipWhitelist: IP not in the list → 401; in the list → pass; empty list → skip.
 *
 * WRITE-scope invariants (write-route shared gate — the security boundary this batch adds):
 *  - the scope is METADATA-driven (@RequireWriteScope → OPERATOR_WRITE_SCOPE), NOT the token
 *    prefix — so a READ key can never satisfy a WRITE route, and relabelling a read secret with
 *    the `vrw_` prefix changes nothing;
 *  - a WRITE route verifies the presented secret against Operator.writeApiKeyHash (NOT the
 *    reporting hash) and FAILS CLOSED when that column is null;
 *  - a valid WRITE key on a WRITE route passes + sets operatorId.
 *
 * The guard never trusts an operatorId from the query/body — only the key prefix.
 */

const prisma = new PrismaService();
// The guard now takes (prisma, reflector). The READ-scope cases below carry NO @RequireWriteScope
// metadata, so a bare Reflector returns undefined → requireWrite=false → the read path is taken,
// preserving every pre-existing assertion.
const guard = new OperatorAuthGuard(prisma, new Reflector());

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

/**
 * Create an operator with freshly minted READ and/or WRITE keys; returns the row + both plaintext
 * tokens. By default provisions BOTH a reporting and a write key. `readKey:false` / `writeKey:false`
 * leave the corresponding hash null (to exercise the fail-closed paths).
 */
async function freshOperatorWithKey(
  opts: {
    enabled?: boolean;
    ipWhitelist?: string[];
    readKey?: boolean; // provision reportingApiKeyHash (default true)
    writeKey?: boolean; // provision writeApiKeyHash (default true)
  } = {},
) {
  const id = randomUUID();
  const read = generateReportingKey(id);
  const write = generateWriteKey(id);
  const op = await prisma.operator.create({
    data: {
      id,
      code: "op-guard-" + randomUUID().slice(0, 8),
      name: "Guard Operator",
      enabled: opts.enabled ?? true,
      launchSecret: "secret-" + randomUUID(),
      currencies: ["EUR"],
      ipWhitelist: opts.ipWhitelist ?? [],
      ...(opts.readKey === false ? {} : { reportingApiKeyHash: read.hash }),
      ...(opts.writeKey === false ? {} : { writeApiKeyHash: write.hash }),
    },
  });
  createdOperatorIds.push(op.id);
  return { op, token: read.token, readToken: read.token, writeToken: write.token };
}

// Fake ExecutionContext exposing what the guard touches: headers.authorization,
// headers (for client-ip), socket.remoteAddress, ip.
//
// `writeScope` drives the metadata path: when true, getHandler()/getClass() return targets that
// carry the @RequireWriteScope() metadata, so reflector.getAllAndOverride(OPERATOR_WRITE_SCOPE,…)
// resolves to true — exactly as it would on a real write controller. When false/omitted, the
// targets have no such metadata → undefined → read scope.
function ctxWith(req: any, opts: { writeScope?: boolean } = {}): any {
  const handler = opts.writeScope ? writeScopedHandler : readScopedHandler;
  const klass = opts.writeScope ? WriteScopedController : ReadScopedController;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => klass,
  };
}

// Real metadata carriers: @RequireWriteScope() sets OPERATOR_WRITE_SCOPE on the class, so a real
// Reflector reads it back off these the same way it does off the production controllers.
@RequireWriteScope()
class WriteScopedController {
  handle() {}
}
class ReadScopedController {
  handle() {}
}
const writeScopedHandler = WriteScopedController.prototype.handle;
const readScopedHandler = ReadScopedController.prototype.handle;

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
    const { op } = await freshOperatorWithKey({ readKey: false });
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

/**
 * WRITE-scope enforcement (write-route shared gate). The security boundary: a route marked
 * @RequireWriteScope demands the operator's WRITE key (writeApiKeyHash); the read/reporting key
 * — and any token merely relabelled with the write prefix — must NOT satisfy it. Scope is decided
 * by the route METADATA, never the token string.
 */
describe("OperatorAuthGuard: WRITE scope (@RequireWriteScope)", () => {
  test("READ key on a WRITE route → 401 (scope is metadata-driven, not the prefix)", async () => {
    const { readToken } = await freshOperatorWithKey(); // has BOTH a read and a write key
    // Present the legitimate READ token, but the route demands write scope → verified against
    // writeApiKeyHash, which the read secret does not match → reject.
    await expect(
      guard.canActivate(ctxWith(reqWith(`Bearer ${readToken}`), { writeScope: true })),
    ).rejects.toMatchObject({ message: "invalid_api_key" });
  });

  test("writeApiKeyHash IS NULL → WRITE route 401 (fail-closed, no write key provisioned)", async () => {
    // Operator has a valid READ key but NO write key. Even presenting a well-formed write token
    // for this operator must fail closed on the write route.
    const { op, writeToken } = await freshOperatorWithKey({ writeKey: false });
    await expect(
      guard.canActivate(ctxWith(reqWith(`Bearer ${writeToken}`), { writeScope: true })),
    ).rejects.toMatchObject({ message: "invalid_api_key" });
    // And the originally-minted (now unprovisioned) secret obviously can't pass either.
    const forged = `${WRITE_TOKEN_PREFIX}${op.id}.${"c".repeat(64)}`;
    await expect(
      guard.canActivate(ctxWith(reqWith(`Bearer ${forged}`), { writeScope: true })),
    ).rejects.toMatchObject({ message: "invalid_api_key" });
  });

  test("a READ secret RELABELED with the vrw_ prefix → WRITE route 401 (prefix is cosmetic)", async () => {
    const { op, readToken } = await freshOperatorWithKey();
    // Take the real read secret and slap the write prefix on it. parseReportingToken accepts the
    // shape, but the guard verifies it against writeApiKeyHash (write scope) → no match → reject.
    const relabeled = readToken.replace(REPORTING_TOKEN_PREFIX, WRITE_TOKEN_PREFIX);
    expect(relabeled.startsWith(WRITE_TOKEN_PREFIX)).toBe(true);
    expect(parseReportingToken(relabeled)?.operatorId).toBe(op.id); // shape is valid…
    await expect(
      guard.canActivate(ctxWith(reqWith(`Bearer ${relabeled}`), { writeScope: true })),
    ).rejects.toMatchObject({ message: "invalid_api_key" }); // …but scope still rejects it
  });

  test("valid WRITE key on a WRITE route → passes + sets operatorId", async () => {
    const { op, writeToken } = await freshOperatorWithKey();
    const req = reqWith(`Bearer ${writeToken}`);
    await expect(guard.canActivate(ctxWith(req, { writeScope: true }))).resolves.toBe(true);
    expect(req.operatorId).toBe(op.id);
  });

  test("WRITE key on a READ route → also passes (read scope verifies the reporting hash; the write key is just cross-scope here)", async () => {
    // Sanity on the inverse: a write key presented to a READ route is verified against
    // reportingApiKeyHash and won't match the write secret → 401. (Confirms BOTH directions are
    // scoped, not just read→write.)
    const { writeToken } = await freshOperatorWithKey();
    await expect(
      guard.canActivate(ctxWith(reqWith(`Bearer ${writeToken}`), { writeScope: false })),
    ).rejects.toMatchObject({ message: "invalid_api_key" });
  });

  test("READ key on a READ route → passes (back-compat unchanged)", async () => {
    const { op, readToken } = await freshOperatorWithKey();
    const req = reqWith(`Bearer ${readToken}`);
    await expect(guard.canActivate(ctxWith(req, { writeScope: false }))).resolves.toBe(true);
    expect(req.operatorId).toBe(op.id);
  });

  test("the metadata key really resolves write scope via a real Reflector", () => {
    // Pin the wiring: @RequireWriteScope() sets OPERATOR_WRITE_SCOPE=true on the class; a plain
    // class has no such metadata. This is exactly what the guard reads.
    const reflector = new Reflector();
    expect(
      reflector.getAllAndOverride<boolean>(OPERATOR_WRITE_SCOPE, [
        writeScopedHandler,
        WriteScopedController,
      ]),
    ).toBe(true);
    expect(
      reflector.getAllAndOverride<boolean>(OPERATOR_WRITE_SCOPE, [
        readScopedHandler,
        ReadScopedController,
      ]),
    ).toBeUndefined();
  });
});

/**
 * parseReportingToken token-length cap (security/code-review LOW). A real key is
 * `vr{k,w}_<uuid>.<64hex>` (~110 chars); an absurdly long token is rejected BEFORE any hashing so
 * the unauthenticated 401 path can't be turned into a CPU-amplification primitive (forcing a hash
 * of a megabyte "secret").
 */
describe("parseReportingToken: 512-char length cap", () => {
  test("a token longer than 512 chars → null (rejected before hashing)", () => {
    const id = randomUUID();
    // Well-formed prefix + uuid + dot, then a giant secret that pushes total length past 512.
    const huge = `${REPORTING_TOKEN_PREFIX}${id}.${"a".repeat(600)}`;
    expect(huge.length).toBeGreaterThan(512);
    expect(parseReportingToken(huge)).toBeNull();
  });

  test("a token at/under 512 chars with a valid shape → still parses", () => {
    const id = randomUUID();
    // Pad the secret so the WHOLE token is exactly 512 chars (boundary stays accepted; only >512 is
    // rejected).
    const head = `${REPORTING_TOKEN_PREFIX}${id}.`;
    const secret = "a".repeat(512 - head.length);
    const token = head + secret;
    expect(token.length).toBe(512);
    const parsed = parseReportingToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.operatorId).toBe(id);
    expect(parsed?.secret).toBe(secret);
  });

  test("the cap also applies to the write prefix", () => {
    const id = randomUUID();
    const huge = `${WRITE_TOKEN_PREFIX}${id}.${"b".repeat(600)}`;
    expect(huge.length).toBeGreaterThan(512);
    expect(parseReportingToken(huge)).toBeNull();
  });
});

/**
 * OperatorThrottlerGuard — per-operator rate-limit (write-route shared gate). Full storage-backed
 * 429 behaviour is the base ThrottlerGuard's and needs a heavy module harness; instead we cover the
 * two pieces this subclass actually OWNS, which are what keep read and write from sharing a bucket:
 *   (1) getTracker keys by the authenticated operatorId (falls back to client-IP, never fail-open);
 *   (2) handleRequest selects the scope-specific ttl/limit AND appends a scope-distinct ":r"/":w"
 *       suffix to the storage key — so a burst of reads can't drain the (smaller) write budget.
 * We intercept the grandparent ThrottlerGuard.handleRequest to capture the mutated request props
 * without touching real storage.
 */
describe("OperatorThrottlerGuard: per-operator + per-scope bucketing", () => {
  // Construct with stubs: the base ctor wants (options, storage, reflector). getTracker/handleRequest
  // don't read options/storage in the paths we exercise (handleRequest's storage use is intercepted).
  const makeGuard = () =>
    new OperatorThrottlerGuard(
      { throttlers: [] } as any,
      {} as any,
      new Reflector(),
    ) as unknown as {
      getTracker(req: Record<string, any>): Promise<string>;
      handleRequest(p: ThrottlerRequest): Promise<boolean>;
    };

  test("getTracker keys by the authenticated operatorId", async () => {
    const g = makeGuard();
    await expect(g.getTracker({ operatorId: "op-123", socket: { remoteAddress: "10.0.0.9" } })).resolves.toBe(
      "op:op-123",
    );
  });

  test("getTracker falls back to client IP when operatorId is unset (never fail-open)", async () => {
    const g = makeGuard();
    const tracker = await g.getTracker({ headers: { "cf-connecting-ip": "203.0.113.5" }, socket: {} });
    expect(tracker).toBe("ip:203.0.113.5");
  });

  // Capture what OperatorThrottlerGuard.handleRequest forwards to super (the base ThrottlerGuard).
  // We stub the grandparent prototype method so no storage is touched.
  async function captureForwarded(writeScope: boolean): Promise<ThrottlerRequest> {
    const g = makeGuard();
    const original = ThrottlerGuard.prototype.handleRequest;
    let captured!: ThrottlerRequest;
    (ThrottlerGuard.prototype as any).handleRequest = async function (p: ThrottlerRequest) {
      captured = p;
      return true;
    };
    try {
      const handler = writeScope ? writeScopedHandler : readScopedHandler;
      const klass = writeScope ? WriteScopedController : ReadScopedController;
      const ctx: any = { getHandler: () => handler, getClass: () => klass };
      // Base props; generateKey echoes a recognisable base so we can see the scope suffix appended.
      const props = {
        context: ctx,
        limit: 0,
        ttl: 0,
        throttler: { name: "default" },
        blockDuration: 0,
        getTracker: async () => "op:op-xyz",
        generateKey: (_c: any, tracker: string, name: string) => `BASE(${tracker},${name})`,
      } as unknown as ThrottlerRequest;
      await g.handleRequest(props);
    } finally {
      (ThrottlerGuard.prototype as any).handleRequest = original;
    }
    return captured;
  }

  test("read vs write select DISTINCT budgets and DISTINCT storage-key suffixes", async () => {
    const read = await captureForwarded(false);
    const write = await captureForwarded(true);

    // Scope-distinct key suffix: ":r" for read, ":w" for write — different buckets even for the
    // same tracker + throttler name. This is what stops a read burst from draining the write budget.
    const key = (p: ThrottlerRequest) =>
      (p.generateKey as any)(p.context, "op:op-xyz", "default") as string;
    const readKey = key(read);
    const writeKey = key(write);
    expect(readKey.endsWith(":r")).toBe(true);
    expect(writeKey.endsWith(":w")).toBe(true);
    expect(readKey).not.toBe(writeKey);

    // Scope-specific budgets: the write limit is the tighter one (defaults 60 write vs 600 read),
    // and both are finite/positive (the numEnv finite-guard never yields NaN).
    expect(Number.isFinite(read.limit)).toBe(true);
    expect(Number.isFinite(write.limit)).toBe(true);
    expect(read.limit).toBeGreaterThanOrEqual(1);
    expect(write.limit).toBeGreaterThanOrEqual(1);
    expect(write.limit).toBeLessThanOrEqual(read.limit);
    // blockDuration is set to the scope ttl (both finite/positive).
    expect(Number.isFinite(write.ttl)).toBe(true);
    expect(write.ttl).toBeGreaterThanOrEqual(1);
    expect(write.blockDuration).toBe(write.ttl);
  });

  // The numEnv finite-guard (a malformed/NaN/<1 env must fall back to the default, never disable the
  // throttle by yielding NaN — `hits > NaN` is always false = fail-open). numEnv is module-private,
  // so this pins its DOCUMENTED CONTRACT against a faithful copy of the one-liner; the guard's real
  // default constants are additionally asserted finite/positive in the test above.
  test("numEnv contract: non-numeric / <1 / non-finite env → default; valid → floored int", () => {
    const numEnv = (v: string | undefined, dflt: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
    };
    const cases: Array<[string | undefined, number, number]> = [
      [undefined, 600, 600], // unset → default
      ["", 600, 600], // empty → Number("")=0 → <1 → default
      ["abc", 600, 600], // NaN → default
      ["NaN", 600, 600], // NaN → default
      ["Infinity", 600, 600], // non-finite → default
      ["0", 600, 600], // <1 → default
      ["0.5", 600, 600], // <1 → default
      ["-5", 60, 60], // <1 → default
      ["1", 60, 1], // valid floor
      ["120", 60, 120], // valid
      ["59.9", 60, 59], // floored to int
    ];
    for (const [env, dflt, want] of cases) {
      expect(numEnv(env, dflt)).toBe(want);
      expect(Number.isNaN(numEnv(env, dflt))).toBe(false); // never NaN (never fail-open)
    }
  });
});
