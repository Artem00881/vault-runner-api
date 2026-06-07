import { test, expect, describe } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  parseTransactionQuery,
  type TransactionQuery,
} from "../src/operator/reporting-query";
import {
  debitStateOf,
  refundStateOf,
  payoutStateOf,
  type DebitState,
  type RefundState,
  type PayoutState,
} from "../src/operator/reporting.service";

/**
 * Phase 6 — operator TRANSACTION-STATUS lookup, PURE units (NO DB).
 *
 * Two pure surfaces are exercised here so an operator that lost a `/bet` or `/win`
 * response can learn the final disposition WITHOUT the parser/mapper ever throwing a
 * non-BadRequest (a 500) on hostile input:
 *  - parseTransactionQuery: betId | transactionId → a discriminated TransactionQuery;
 *    EVERY malformed input must throw BadRequestException (clean 400), never anything
 *    else, and never resolve. Prototype-pollution-safe (reads only known keys; an
 *    object/array value validates as missing — same posture as parseReportQuery).
 *  - debitStateOf / refundStateOf / payoutStateOf: canonical bet status → an explicit
 *    money-move disposition (a TRANSIENT status is "pending", NEVER a flat boolean an
 *    operator could read as "did not happen"). These ARE certification evidence — the
 *    contract an operator reconciles against (api-integration-spec §13).
 */

// A canonical lowercase v4-shape uuid for the embedded-id forms.
const uuid = () => randomUUID();

describe("TXP.1 parseTransactionQuery — betId form", () => {
  test("a valid uuid betId → { kind: 'betId', betId }", () => {
    const betId = uuid();
    const q = parseTransactionQuery({ betId });
    expect(q.kind).toBe("betId");
    expect(q.betId).toBe(betId);
    // betId form carries NO transactionId.
    expect((q as Extract<TransactionQuery, { kind: "betId" }>).transactionId).toBeUndefined();
  });

  test("UPPERCASE uuid betId is accepted (UUID_RE is case-insensitive)", () => {
    const betId = uuid().toUpperCase();
    const q = parseTransactionQuery({ betId });
    expect(q.kind).toBe("betId");
    expect(q.betId).toBe(betId);
  });

  test("a betId with surrounding whitespace is trimmed then validated", () => {
    const betId = uuid();
    const q = parseTransactionQuery({ betId: `  ${betId}  ` });
    expect(q.kind).toBe("betId");
    expect(q.betId).toBe(betId);
  });

  test("a non-uuid betId → BadRequestException", () => {
    expect(() => parseTransactionQuery({ betId: "not-a-uuid" })).toThrow(BadRequestException);
  });
});

describe("TXP.2 parseTransactionQuery — transactionId forms resolve to the right kind", () => {
  test("bet:{betId}:payout → kind 'payout' (betId parsed, transactionId echoed)", () => {
    const betId = uuid();
    const transactionId = `bet:${betId}:payout`;
    const q = parseTransactionQuery({ transactionId });
    expect(q.kind).toBe("payout");
    expect((q as Extract<TransactionQuery, { kind: "payout" | "refund" }>).betId).toBe(betId);
    expect((q as Extract<TransactionQuery, { kind: "payout" | "refund" }>).transactionId).toBe(transactionId);
  });

  test("bet:{betId}:refund → kind 'refund'", () => {
    const betId = uuid();
    const transactionId = `bet:${betId}:refund`;
    const q = parseTransactionQuery({ transactionId });
    expect(q.kind).toBe("refund");
    expect((q as Extract<TransactionQuery, { kind: "payout" | "refund" }>).betId).toBe(betId);
    expect((q as Extract<TransactionQuery, { kind: "payout" | "refund" }>).transactionId).toBe(transactionId);
  });

  test("bet:{betId}:restart_refund → kind 'refund' (recovery refund is refund-class)", () => {
    const betId = uuid();
    const transactionId = `bet:${betId}:restart_refund`;
    const q = parseTransactionQuery({ transactionId });
    expect(q.kind).toBe("refund");
    expect((q as Extract<TransactionQuery, { kind: "payout" | "refund" }>).betId).toBe(betId);
    expect((q as Extract<TransactionQuery, { kind: "payout" | "refund" }>).transactionId).toBe(transactionId);
  });

  test("bet:{roundId}:{userId}:A:debit → kind 'debit' (roundId/userId/panel A parsed)", () => {
    const roundId = uuid();
    const userId = uuid();
    const transactionId = `bet:${roundId}:${userId}:A:debit`;
    const q = parseTransactionQuery({ transactionId });
    expect(q.kind).toBe("debit");
    const d = q as Extract<TransactionQuery, { kind: "debit" }>;
    expect(d.roundId).toBe(roundId);
    expect(d.userId).toBe(userId);
    expect(d.panel).toBe("A");
    expect(d.transactionId).toBe(transactionId);
  });

  test("bet:{roundId}:{userId}:B:debit → kind 'debit' (panel B parsed)", () => {
    const roundId = uuid();
    const userId = uuid();
    const transactionId = `bet:${roundId}:${userId}:B:debit`;
    const q = parseTransactionQuery({ transactionId });
    expect(q.kind).toBe("debit");
    const d = q as Extract<TransactionQuery, { kind: "debit" }>;
    expect(d.roundId).toBe(roundId);
    expect(d.userId).toBe(userId);
    expect(d.panel).toBe("B");
  });
});

// ── Table-driven: every malformed input must throw a clean BadRequestException ─────
describe("TXP.3 parseTransactionQuery — malformed → BadRequest (clean 400, never a 500, never resolves)", () => {
  const u = "11111111-1111-1111-1111-111111111111"; // a valid uuid to embed
  const cases: Array<{ name: string; input: unknown }> = [
    { name: "empty object (neither param)", input: {} },
    { name: "null query", input: null },
    { name: "undefined query", input: undefined },
    { name: "empty-string betId (trims to missing → neither)", input: { betId: "" } },
    { name: "whitespace-only betId", input: { betId: "   " } },
    { name: "empty-string transactionId", input: { transactionId: "" } },
    { name: "whitespace-only transactionId", input: { transactionId: "   " } },
    { name: "BOTH params supplied", input: { betId: u, transactionId: `bet:${u}:payout` } },
    { name: "wrong prefix foo:...", input: { transactionId: `foo:${u}:payout` } },
    { name: "no prefix at all", input: { transactionId: `${u}:payout` } },
    { name: "colon count: bet:x (2 parts)", input: { transactionId: "bet:x" } },
    { name: "colon count: bet:a:b:c:d (5 parts, parts[4]!=debit)", input: { transactionId: "bet:a:b:c:d" } },
    { name: "colon count: 6 parts", input: { transactionId: "bet:a:b:c:d:e" } },
    { name: "non-uuid embedded id (debit form)", input: { transactionId: "bet:not-a-uuid:also-bad:A:debit" } },
    { name: "non-uuid roundId, valid userId (debit form)", input: { transactionId: `bet:nope:${u}:A:debit` } },
    { name: "valid roundId, non-uuid userId (debit form)", input: { transactionId: `bet:${u}:nope:A:debit` } },
    { name: "non-uuid embedded id (payout form)", input: { transactionId: "bet:not-a-uuid:payout" } },
    { name: "non-uuid embedded id (refund form)", input: { transactionId: "bet:not-a-uuid:refund" } },
    { name: "non-uuid embedded id (restart_refund form)", input: { transactionId: "bet:not-a-uuid:restart_refund" } },
    { name: "bad panel C (debit form)", input: { transactionId: `bet:${u}:${u}:C:debit` } },
    { name: "lowercase panel a (debit form)", input: { transactionId: `bet:${u}:${u}:a:debit` } },
    { name: ":debit with 3 parts (bet:{uuid}:debit)", input: { transactionId: `bet:${u}:debit` } },
    { name: ":payout with 5 parts (bet:r:u:A:payout)", input: { transactionId: `bet:${u}:${u}:A:payout` } },
    { name: "unknown 3rd token (bet:{uuid}:settled)", input: { transactionId: `bet:${u}:settled` } },
    { name: "trailing colon (bet:{uuid}:payout:)", input: { transactionId: `bet:${u}:payout:` } },
  ];

  for (const c of cases) {
    test(`${c.name} → BadRequestException`, () => {
      let thrown: unknown;
      try {
        parseTransactionQuery(c.input);
      } catch (e) {
        thrown = e;
      }
      // Must have thrown, and specifically a BadRequestException (a clean 400) — never
      // a TypeError/other (which Nest would surface as a 500).
      expect(thrown).toBeInstanceOf(BadRequestException);
    });
  }
});

describe("TXP.4 parseTransactionQuery — object/array injection treated as missing (proto-pollution posture)", () => {
  // A non-string value validates as MISSING (asString returns undefined) → so an array
  // / object for transactionId or betId collapses to "neither param" → BadRequest, and
  // can NEVER hit .split()/.test() on a non-string (no 500). Mirrors parseReportQuery.
  const cases: Array<{ name: string; input: unknown }> = [
    { name: "transactionId as array ['a','b']", input: { transactionId: ["a", "b"] } },
    { name: "transactionId as object {x:1}", input: { transactionId: { x: 1 } } },
    { name: "betId as array", input: { betId: ["a", "b"] } },
    { name: "betId as object", input: { betId: { x: 1 } } },
    { name: "transactionId as number", input: { transactionId: 12345 } },
    { name: "betId as boolean", input: { betId: true } },
    { name: "__proto__-keyed object (own-key-safe)", input: JSON.parse('{"__proto__":{"transactionId":"bet:x:payout"}}') },
  ];
  for (const c of cases) {
    test(`${c.name} → BadRequestException (no non-BadRequest throw)`, () => {
      let thrown: unknown;
      try {
        parseTransactionQuery(c.input);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
    });
  }
});

// ── B. the status → money-move state matrix (pure mappers) ─────────────────────────
describe("TXP.5 debitStateOf — status → DebitState", () => {
  const cases: Array<[string, DebitState]> = [
    ["reserving", "pending"], // debit may or may not have applied — RGS reconciles
    ["active", "applied"],
    ["cashed_out", "applied"],
    ["busted", "applied"],
    ["payout_pending", "applied"],
    ["cancelling", "applied"], // stake WAS debited; a refund is in flight (see refundState)
    ["cancelled", "reversed"], // debited then fully refunded (net zero)
  ];
  for (const [status, expected] of cases) {
    test(`${status} → ${expected}`, () => {
      expect(debitStateOf(status)).toBe(expected);
    });
  }
});

describe("TXP.6 refundStateOf — status → RefundState", () => {
  const cases: Array<[string, RefundState]> = [
    ["cancelling", "pending"], // refund in flight
    ["cancelled", "applied"], // refund completed
    // everything else → none
    ["reserving", "none"],
    ["active", "none"],
    ["cashed_out", "none"],
    ["busted", "none"],
    ["payout_pending", "none"],
  ];
  for (const [status, expected] of cases) {
    test(`${status} → ${expected}`, () => {
      expect(refundStateOf(status)).toBe(expected);
    });
  }
});

describe("TXP.7 payoutStateOf — status → PayoutState", () => {
  const cases: Array<[string, PayoutState]> = [
    ["cashed_out", "paid"], // payout credited AND confirmed
    ["payout_pending", "pending"], // win owed; operator credit unconfirmed
    // everything else → none
    ["reserving", "none"],
    ["active", "none"],
    ["busted", "none"],
    ["cancelling", "none"],
    ["cancelled", "none"],
  ];
  for (const [status, expected] of cases) {
    test(`${status} → ${expected}`, () => {
      expect(payoutStateOf(status)).toBe(expected);
    });
  }
});
