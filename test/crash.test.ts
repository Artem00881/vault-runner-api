import { test, expect } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { crashFromHmacHex, computeCrash, HOUSE_EDGE } from "../src/fairness/crash";

/**
 * Deterministic 32-byte hex seed stream from a fixed master seed (SHA-256 counter mode:
 * seed_i = SHA256(master || i)). Used by the distribution test below so the 100k-sample
 * empirical RTP / P(crash≥x) is REPRODUCIBLE every run — the test validates the crash
 * MATH distribution, which a large FIXED-seed sample reproduces deterministically. This
 * removes the intermittent CI flake the old `randomBytes` sample caused (the empirical
 * fractions drifted run-to-run and occasionally tripped the ±tolerance). The seeds are
 * still full-entropy SHA-256 digests fed through the REAL computeCrash — only their
 * SOURCE is deterministic, so the distribution under test is unchanged.
 */
function seededSeedHex(master: string, i: number): string {
  return createHash("sha256").update(`${master}:${i}`).digest("hex");
}

test("house edge is 3%", () => {
  expect(HOUSE_EDGE).toBe(0.03);
});

test("edge cases: min hash → capped max, max hash → instant bust", () => {
  // hInt = 0 → astronomically large → capped at 1,000,000.00x
  expect(crashFromHmacHex("0".repeat(13) + "abc")).toBe(1_000_000);
  // hInt = 2^52 - 1 (13 f's) → ~0.97 → clamped to 1.00x (bust)
  expect(crashFromHmacHex("f".repeat(13))).toBe(1.0);
});

test("computeCrash is deterministic for the same seed+salt", () => {
  const seed = randomBytes(32).toString("hex");
  const salt = randomBytes(32).toString("hex");
  expect(computeCrash(seed, salt)).toBe(computeCrash(seed, salt));
});

test("crash is always >= 1.00", () => {
  const salt = randomBytes(32).toString("hex");
  for (let i = 0; i < 5000; i++) {
    expect(computeCrash(randomBytes(32).toString("hex"), salt)).toBeGreaterThanOrEqual(1.0);
  }
});

test("distribution matches P(crash >= x) ≈ 0.97 / x and RTP ≈ 97% (deterministic sample)", () => {
  // DETERMINISTIC sample (fixed master seed → reproducible every run; was randomBytes,
  // which flaked intermittently in CI). Same N=100k as before; the seeds come from the
  // SHA-256 counter-mode stream above and are fed through the REAL computeCrash, so this
  // still validates the crash-math distribution — it just does so reproducibly.
  const N = 100_000;
  const salt = seededSeedHex("crash-dist-salt", 0); // fixed salt (a 32-byte hex digest)
  const crashes: number[] = new Array(N);
  for (let i = 0; i < N; i++) crashes[i] = computeCrash(seededSeedHex("crash-dist-seed", i), salt);

  const frac = (x: number) => crashes.filter((c) => c >= x).length / N;

  // P(crash >= x) ≈ 0.97 / x
  for (const x of [2, 3, 5, 10]) {
    expect(frac(x)).toBeCloseTo(0.97 / x, 1); // within ±0.05; 100k keeps it tight
  }

  // instant-bust cluster at exactly 1.00x is a few percent
  const bust = crashes.filter((c) => c === 1.0).length / N;
  expect(bust).toBeGreaterThan(0.02);
  expect(bust).toBeLessThan(0.06);

  // RTP for a fixed cash-out target T = T * P(crash >= T) ≈ 0.97
  for (const T of [2, 5]) {
    const rtp = T * frac(T);
    expect(rtp).toBeGreaterThan(0.95);
    expect(rtp).toBeLessThan(0.99);
  }
});
