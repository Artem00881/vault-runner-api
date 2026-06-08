import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { provisionOperator } from "../scripts/operator-provision";
import {
  parseReportingToken,
  verifyReportingSecret,
  REPORTING_TOKEN_PREFIX,
} from "../src/operator/reporting-key";

/**
 * Phase 3, piece 1 — provisionOperator (DB upsert by `code`).
 *
 * The repeatable replacement for a manual operator INSERT. Invariants:
 *  - CREATE makes exactly one row and generates a launchSecret (returned once);
 *  - re-running with the same `code` UPDATES that one row (no second row), only
 *    the provided fields change, and the launchSecret is PRESERVED;
 *  - rotateSecret changes the launchSecret (and returns the new one);
 *  - invalid betLimits THROWS (validateBetLimits gate) and leaves the DB
 *    unchanged — bad config never lands;
 *  - only-provided-fields semantics: an update that omits a field leaves it intact.
 */

const prisma = new PrismaService();

// Track codes we create for FK-safe teardown (delete journal users by tag, then
// the operator — though provisionOperator never opens sessions, so only the
// operator row exists here).
const createdCodes: string[] = [];

function freshCode() {
  const code = "prov-" + randomUUID().slice(0, 8);
  createdCodes.push(code);
  return code;
}

// generateReportingKey (called by provisionOperator on --rotate-reporting-key) reads
// REPORTING_KEY_PEPPER at hash time; the bun process is shared, so run with no pepper
// and restore whatever was there after each test (env hygiene).
const SAVED_PEPPER = process.env.REPORTING_KEY_PEPPER;
beforeAll(async () => {
  delete process.env.REPORTING_KEY_PEPPER;
  await prisma.$connect();
});
afterEach(() => {
  if (SAVED_PEPPER === undefined) delete process.env.REPORTING_KEY_PEPPER;
  else process.env.REPORTING_KEY_PEPPER = SAVED_PEPPER;
});

afterAll(async () => {
  // Operators created here have no sessions/journal users; delete by code.
  // Resolve ids first so we can also sweep any journal users defensively.
  const ops = await prisma.operator.findMany({ where: { code: { in: createdCodes } } });
  for (const op of ops) {
    // F-017: user→wallet (+ wallet→ledger/bet) is now RESTRICT (was CASCADE) — delete the
    // child rows first, then the users (mirrors reserving-backlog-low4 child-first teardown).
    const opUser = { user: { username: { startsWith: `op:${op.id}:` } } } as const;
    await prisma.bet.deleteMany({ where: { wallet: opUser } });
    await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
    await prisma.profile.deleteMany({ where: opUser });
    await prisma.wallet.deleteMany({ where: opUser });
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${op.id}:` } } });
  }
  if (createdCodes.length) {
    await prisma.operator.deleteMany({ where: { code: { in: createdCodes } } });
  }
  await prisma.$disconnect();
});

describe("provisionOperator: create", () => {
  test("create makes exactly one row and returns a launchSecret", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, {
      code,
      name: "Demo Casino",
      currencies: ["EUR", "USDT"],
    });

    expect(res.created).toBe(true);
    expect(res.launchSecret).toBeTruthy();
    // The returned secret is the one persisted.
    expect(res.launchSecret).toBe(res.operator.launchSecret);

    // Exactly one row exists for this code.
    const rows = await prisma.operator.findMany({ where: { code } });
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Demo Casino");
    expect(rows[0].currencies).toEqual(["EUR", "USDT"]);
    expect(rows[0].enabled).toBe(true); // defaulted on create
  });

  test("create defaults name to code and currencies to [] when omitted", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code });
    expect(res.created).toBe(true);
    expect(res.operator.name).toBe(code); // name ?? code
    expect(res.operator.currencies).toEqual([]);
    expect(res.operator.walletApiUrl).toBeNull();
    expect(res.operator.betLimits).toBeNull();
  });

  test("create persists a valid betLimits config", async () => {
    const code = freshCode();
    const limits = { EUR: { minBet: 10, maxBet: 10000, maxWinPerBet: 1000000 } };
    const res = await provisionOperator(prisma, { code, currencies: ["EUR"], betLimits: limits });
    expect(res.created).toBe(true);
    expect(res.operator.betLimits).toEqual(limits);
  });
});

describe("provisionOperator: update (upsert by code)", () => {
  test("re-running with the same code UPDATES one row, changes fields, PRESERVES the secret", async () => {
    const code = freshCode();
    const first = await provisionOperator(prisma, {
      code,
      name: "Original",
      currencies: ["EUR"],
      walletApiUrl: "https://op.example/wallet",
    });
    const originalSecret = first.launchSecret!;
    expect(first.created).toBe(true);

    // Update: change name + currencies, no rotateSecret.
    const second = await provisionOperator(prisma, {
      code,
      name: "Renamed",
      currencies: ["EUR", "USD"],
    });

    expect(second.created).toBe(false);
    // Secret NOT returned on a plain update (only on create/rotate).
    expect(second.launchSecret).toBeUndefined();
    // And the persisted secret is unchanged.
    expect(second.operator.launchSecret).toBe(originalSecret);
    expect(second.operator.name).toBe("Renamed");
    expect(second.operator.currencies).toEqual(["EUR", "USD"]);

    // Still exactly one row (upsert, not insert).
    const rows = await prisma.operator.findMany({ where: { code } });
    expect(rows.length).toBe(1);
    expect(rows[0].launchSecret).toBe(originalSecret);
  });

  test("only-provided-fields: an update that omits a field leaves it intact", async () => {
    const code = freshCode();
    await provisionOperator(prisma, {
      code,
      name: "Keep Me",
      currencies: ["EUR"],
      walletApiUrl: "https://keep.example/wallet",
      callbackUrl: "https://keep.example/lobby",
      betLimits: { EUR: { minBet: 5, maxBet: 500, maxWinPerBet: 5000 } },
    });

    // Update ONLY currencies — every other field must survive untouched.
    const upd = await provisionOperator(prisma, { code, currencies: ["EUR", "GBP"] });
    expect(upd.created).toBe(false);
    expect(upd.operator.currencies).toEqual(["EUR", "GBP"]);
    expect(upd.operator.name).toBe("Keep Me"); // untouched
    expect(upd.operator.walletApiUrl).toBe("https://keep.example/wallet"); // untouched
    expect(upd.operator.callbackUrl).toBe("https://keep.example/lobby"); // untouched
    expect(upd.operator.betLimits).toEqual({ EUR: { minBet: 5, maxBet: 500, maxWinPerBet: 5000 } }); // untouched
  });

  test("enabled:false on update disables the operator; omitting enabled later leaves it disabled", async () => {
    const code = freshCode();
    await provisionOperator(prisma, { code, currencies: ["EUR"] }); // enabled defaults true
    const disabled = await provisionOperator(prisma, { code, enabled: false });
    expect(disabled.operator.enabled).toBe(false);
    // A later update that omits `enabled` must NOT silently re-enable it.
    const renamed = await provisionOperator(prisma, { code, name: "Still Off" });
    expect(renamed.operator.enabled).toBe(false);
  });
});

describe("provisionOperator: rotateSecret", () => {
  test("rotateSecret changes the launchSecret and returns the new one", async () => {
    const code = freshCode();
    const first = await provisionOperator(prisma, { code, currencies: ["EUR"] });
    const originalSecret = first.launchSecret!;

    const rotated = await provisionOperator(prisma, { code, rotateSecret: true });
    expect(rotated.created).toBe(false);
    expect(rotated.launchSecret).toBeTruthy(); // returned on rotate
    expect(rotated.launchSecret).not.toBe(originalSecret); // actually rotated
    expect(rotated.operator.launchSecret).toBe(rotated.launchSecret); // persisted

    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.launchSecret).toBe(rotated.launchSecret);
    expect(row.launchSecret).not.toBe(originalSecret);
  });
});

describe("provisionOperator: invalid betLimits is rejected before any write", () => {
  test("invalid betLimits THROWS on create and writes NO row", async () => {
    const code = freshCode();
    await expect(
      provisionOperator(prisma, {
        code,
        currencies: ["EUR"],
        // maxBet < minBet → refinement fails.
        betLimits: { EUR: { minBet: 1000, maxBet: 10, maxWinPerBet: 100000 } },
      }),
    ).rejects.toThrow();

    // The validate gate runs BEFORE the upsert → no operator row was created.
    const rows = await prisma.operator.findMany({ where: { code } });
    expect(rows.length).toBe(0);
  });

  test("invalid betLimits THROWS on update and leaves the existing row UNCHANGED", async () => {
    const code = freshCode();
    const good = await provisionOperator(prisma, {
      code,
      name: "Good State",
      currencies: ["EUR"],
      betLimits: { EUR: { minBet: 10, maxBet: 1000, maxWinPerBet: 10000 } },
    });
    const goodLimits = good.operator.betLimits;
    const goodSecret = good.launchSecret!;

    await expect(
      provisionOperator(prisma, {
        code,
        name: "Should Not Apply",
        // negative + non-integer → invalid.
        betLimits: { EUR: { minBet: -5, maxBet: 1000.5, maxWinPerBet: 1 } },
      }),
    ).rejects.toThrow();

    // Row is byte-for-byte unchanged: name, betLimits and secret all preserved.
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.name).toBe("Good State");
    expect(row.betLimits).toEqual(goodLimits as object);
    expect(row.launchSecret).toBe(goodSecret);
  });
});

describe("provisionOperator: callbackUrl validation (Phase 3 go-live)", () => {
  test("a valid https callbackUrl persists", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, {
      code,
      currencies: ["EUR"],
      callbackUrl: "https://op.example/lobby",
    });
    expect(res.created).toBe(true);
    expect(res.operator.callbackUrl).toBe("https://op.example/lobby");
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.callbackUrl).toBe("https://op.example/lobby");
  });

  test("a valid http callbackUrl persists too", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code, currencies: ["EUR"], callbackUrl: "http://op.example/back" });
    expect(res.operator.callbackUrl).toBe("http://op.example/back");
  });

  // Table-driven: every malformed/dangerous URL must THROW before any write (mirrors the
  // invalid-betLimits "DB unchanged" invariant — bad config never lands).
  const BAD = [
    ["ftp scheme", "ftp://x"],
    ["javascript: scheme (XSS)", "javascript:alert(1)"],
    ["not a url", "not-a-url"],
  ] as const;
  for (const [label, url] of BAD) {
    test(`invalid callbackUrl (${label}) THROWS on create and writes NO row`, async () => {
      const code = freshCode();
      await expect(
        provisionOperator(prisma, { code, currencies: ["EUR"], callbackUrl: url }),
      ).rejects.toThrow(/callbackUrl/i);
      // The validate gate runs BEFORE the upsert → no operator row was created.
      const rows = await prisma.operator.findMany({ where: { code } });
      expect(rows.length).toBe(0);
    });
  }

  test("invalid callbackUrl THROWS on UPDATE and leaves the existing row UNCHANGED", async () => {
    const code = freshCode();
    const good = await provisionOperator(prisma, {
      code,
      name: "Good State",
      currencies: ["EUR"],
      callbackUrl: "https://good.example/lobby",
    });
    const goodSecret = good.launchSecret!;

    await expect(
      provisionOperator(prisma, { code, name: "Should Not Apply", callbackUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/callbackUrl/i);

    // Byte-for-byte unchanged: name, callbackUrl and secret all preserved (no partial write).
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.name).toBe("Good State");
    expect(row.callbackUrl).toBe("https://good.example/lobby");
    expect(row.launchSecret).toBe(goodSecret);
  });
});

describe("provisionOperator: rotateReportingKey (Phase 3.5)", () => {
  test("returns a plaintext reporting token ONCE and persists only its hash", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, {
      code,
      currencies: ["EUR"],
      rotateReportingKey: true,
    });
    expect(res.reportingApiKey).toBeTruthy();
    // The token embeds this operator's id and the vrk_ prefix.
    expect(res.reportingApiKey!.startsWith(`${REPORTING_TOKEN_PREFIX}${res.operator.id}.`)).toBe(true);

    // The DB stores a HASH, never the plaintext token/secret.
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.reportingApiKeyHash).toBeTruthy();
    expect(row.reportingApiKeyHash).not.toBe(res.reportingApiKey);
    const secret = parseReportingToken(res.reportingApiKey)!.secret;
    expect(row.reportingApiKeyHash).not.toContain(secret);

    // The returned token verifies against the stored hash.
    expect(verifyReportingSecret(secret, row.reportingApiKeyHash)).toBe(true);
  });

  test("NOT rotating leaves reportingApiKeyHash null + returns no token", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code, currencies: ["EUR"] }); // no rotateReportingKey
    expect(res.reportingApiKey).toBeUndefined();
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.reportingApiKeyHash).toBeNull();
  });

  test("re-rotation invalidates the prior key (old secret no longer verifies, new does)", async () => {
    const code = freshCode();
    const first = await provisionOperator(prisma, { code, currencies: ["EUR"], rotateReportingKey: true });
    const firstSecret = parseReportingToken(first.reportingApiKey!)!.secret;
    const afterFirst = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(verifyReportingSecret(firstSecret, afterFirst.reportingApiKeyHash)).toBe(true);

    // Rotate again (preserves the launchSecret — this is a reporting-key-only rotation).
    const second = await provisionOperator(prisma, { code, rotateReportingKey: true });
    const secondSecret = parseReportingToken(second.reportingApiKey!)!.secret;
    expect(second.reportingApiKey).not.toBe(first.reportingApiKey);

    const afterSecond = await prisma.operator.findUniqueOrThrow({ where: { code } });
    // The stored hash changed; the OLD secret no longer verifies, the NEW one does.
    expect(afterSecond.reportingApiKeyHash).not.toBe(afterFirst.reportingApiKeyHash);
    expect(verifyReportingSecret(firstSecret, afterSecond.reportingApiKeyHash)).toBe(false);
    expect(verifyReportingSecret(secondSecret, afterSecond.reportingApiKeyHash)).toBe(true);
    // launchSecret is untouched by a reporting-key rotation.
    expect(afterSecond.launchSecret).toBe(afterFirst.launchSecret);
  });
});

describe("provisionOperator: unknown-currency reporting + strict mode (Phase 3.6)", () => {
  test("a fully-known currency set → unknownCurrencies:[]", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code, currencies: ["EUR", "USDT", "BTC"] });
    expect(res.created).toBe(true);
    expect(res.unknownCurrencies).toEqual([]);
    // Codes are canonicalised UPPERCASE on write.
    expect(res.operator.currencies).toEqual(["EUR", "USDT", "BTC"]);
  });

  test("a known currency in mixed case is still recognised (no false unknown)", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code, currencies: ["eur", "uSdT"] });
    expect(res.unknownCurrencies).toEqual([]); // case-insensitive known-check
    expect(res.operator.currencies).toEqual(["EUR", "USDT"]);
  });

  test("an unknown currency (default = warn) → succeeds + reports it in unknownCurrencies (UPPERCASE)", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code, currencies: ["EUR", "xyz"] });
    expect(res.created).toBe(true); // default mode does NOT throw
    expect(res.unknownCurrencies).toEqual(["XYZ"]); // canonicalised, only the unseeded one
    // The operator row is written with the unknown currency allow-listed.
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.currencies).toEqual(["EUR", "XYZ"]);
  });

  test("strictCurrencies:true + an unknown currency THROWS and writes NO row (fail-first invariant)", async () => {
    const code = freshCode();
    await expect(
      provisionOperator(prisma, { code, currencies: ["EUR", "XYZ"], strictCurrencies: true }),
    ).rejects.toThrow(/unknown currency/i);

    // The strict check runs BEFORE the upsert → no operator row was created.
    const rows = await prisma.operator.findMany({ where: { code } });
    expect(rows.length).toBe(0);
  });

  test("strictCurrencies:true + an unknown currency on UPDATE throws and leaves the row UNCHANGED", async () => {
    const code = freshCode();
    // Seed a good row first.
    const good = await provisionOperator(prisma, { code, name: "Good State", currencies: ["EUR"] });
    const goodSecret = good.launchSecret!;

    await expect(
      provisionOperator(prisma, { code, name: "Should Not Apply", currencies: ["EUR", "NOPE"], strictCurrencies: true }),
    ).rejects.toThrow(/unknown currency/i);

    // Byte-for-byte unchanged: name, currencies and secret all preserved (no partial write).
    const row = await prisma.operator.findUniqueOrThrow({ where: { code } });
    expect(row.name).toBe("Good State");
    expect(row.currencies).toEqual(["EUR"]);
    expect(row.launchSecret).toBe(goodSecret);
  });

  test("strictCurrencies:true with an all-known set does NOT throw", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code, currencies: ["EUR", "JPY"], strictCurrencies: true });
    expect(res.created).toBe(true);
    expect(res.unknownCurrencies).toEqual([]);
  });

  test("no currencies provided → unknownCurrencies:[] (nothing to check)", async () => {
    const code = freshCode();
    const res = await provisionOperator(prisma, { code });
    expect(res.unknownCurrencies).toEqual([]);
  });
});
