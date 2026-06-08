import { test, expect } from "bun:test";
import { withStatementTimeout } from "../src/prisma/prisma.service";

/**
 * Audit H5 / F-048b — withStatementTimeout() appends libpq `options=-c statement_timeout=...`
 * (+ idle_in_transaction_session_timeout) to the APP datasource URL so PG applies the bound to
 * every pooled connection. These assert the URL transform is correct + non-destructive (a bad
 * transform would break every app query, so it must preserve scheme/host/db/existing params).
 */

test("appends statement_timeout + idle_in_transaction options to a plain URL", () => {
  const out = withStatementTimeout("postgresql://vault:vault@localhost:5432/vaultrun", 8000, 10000)!;
  const u = new URL(out);
  expect(u.protocol).toBe("postgresql:");
  expect(u.host).toBe("localhost:5432");
  expect(u.pathname).toBe("/vaultrun");
  const options = u.searchParams.get("options")!;
  expect(options).toContain("-c statement_timeout=8000");
  expect(options).toContain("-c idle_in_transaction_session_timeout=10000");
});

test("preserves existing query params (e.g. ?schema=public)", () => {
  const out = withStatementTimeout("postgresql://vault:vault@localhost:5432/vaultrun?schema=public", 8000, 10000)!;
  const u = new URL(out);
  expect(u.searchParams.get("schema")).toBe("public");
  expect(u.searchParams.get("options")).toContain("statement_timeout=8000");
  // host/db not corrupted by the rebuild (the origin==="null" gotcha)
  expect(u.host).toBe("localhost:5432");
  expect(u.pathname).toBe("/vaultrun");
});

test("merges with a pre-existing options param rather than clobbering it", () => {
  const out = withStatementTimeout(
    "postgresql://vault:vault@localhost:5432/vaultrun?options=-c%20search_path%3Dpublic",
    8000,
    10000,
  )!;
  const options = new URL(out).searchParams.get("options")!;
  expect(options).toContain("search_path=public"); // existing flag kept
  expect(options).toContain("statement_timeout=8000"); // ours appended
});

test("statement_timeout=0 disables the statement bound (omits that flag)", () => {
  const out = withStatementTimeout("postgresql://vault:vault@localhost:5432/vaultrun", 0, 10000)!;
  const options = new URL(out).searchParams.get("options")!;
  expect(options).not.toContain("statement_timeout");
  expect(options).toContain("idle_in_transaction_session_timeout=10000");
});

test("both timeouts 0 → URL returned unchanged (fully disabled)", () => {
  const url = "postgresql://vault:vault@localhost:5432/vaultrun?schema=public";
  expect(withStatementTimeout(url, 0, 0)).toBe(url);
});

test("undefined URL → undefined (let Prisma raise its own clear error)", () => {
  expect(withStatementTimeout(undefined)).toBeUndefined();
});

test("unparseable URL → returned unchanged (handed to Prisma as-is)", () => {
  const garbage = "not a url";
  expect(withStatementTimeout(garbage, 8000, 10000)).toBe(garbage);
});
