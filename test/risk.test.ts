import { test, expect, describe } from "bun:test";
import { RiskService, assertRiskConfigForMode } from "../src/game/risk.service";

// Build a RiskService with explicit limits via env (constructed fresh per test).
function makeRisk(env: Record<string, string>): RiskService {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const r = new RiskService();
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  return r;
}

test("bet amount must be within [minBet, maxBet]", () => {
  const r = makeRisk({ RISK_MIN_BET: "10", RISK_MAX_BET: "1000" });
  expect(r.checkBetAmount(5n).ok).toBe(false);   // below min
  expect(r.checkBetAmount(10n).ok).toBe(true);   // at min
  expect(r.checkBetAmount(1000n).ok).toBe(true); // at max
  expect(r.checkBetAmount(1001n).ok).toBe(false); // above max
});

test("potentialPayout = min(amount × maxMultiplier, maxWinPerBet)", () => {
  const r = makeRisk({ RISK_MAX_MULTIPLIER: "10000", RISK_MAX_WIN_PER_BET: "1000000" });
  // small bet: uncapped (100 × 10000 = 1,000,000 == cap → not exceeded)
  expect(r.potentialPayout(100n)).toBe(1_000_000n);
  // larger bet hits the per-bet win cap: 1000 × 10000 = 10,000,000 > cap → capped
  expect(r.potentialPayout(1000n)).toBe(1_000_000n);
});

test("capPayout clamps an actual payout to the per-bet win cap", () => {
  const r = makeRisk({ RISK_MAX_WIN_PER_BET: "10000" });
  expect(r.capPayout(5_000n)).toBe(5_000n);   // under cap, unchanged
  expect(r.capPayout(50_000n)).toBe(10_000n); // over cap, clamped
});

test("capPayout per-currency override applies a tighter cap but NEVER exceeds the global", () => {
  const r = makeRisk({ RISK_MAX_WIN_PER_BET: "10000" });
  // a per-currency cap BELOW the global applies as-is
  expect(r.capPayout(8_000n, 5_000n)).toBe(5_000n);
  expect(r.capPayout(3_000n, 5_000n)).toBe(3_000n);
  // a per-currency cap ABOVE the global is CLAMPED to the global (money-path audit
  // HIGH: the round-exposure breaker reserves against the GLOBAL cap, so a higher
  // per-currency cap would under-reserve the bankroll).
  expect(r.capPayout(50_000n, 1_000_000n)).toBe(10_000n);
});

test("checkBetAmount per-currency override applies the operator min/max; no override → global", () => {
  const r = makeRisk({ RISK_MIN_BET: "1", RISK_MAX_BET: "1000000" });
  const lim = { minBet: 100n, maxBet: 5000n };
  expect(r.checkBetAmount(50n, lim).ok).toBe(false); // below operator min (above global min)
  expect(r.checkBetAmount(100n, lim).ok).toBe(true); // at operator min
  expect(r.checkBetAmount(5000n, lim).ok).toBe(true); // at operator max
  expect(r.checkBetAmount(5001n, lim).ok).toBe(false); // above operator max (below global max)
  expect(r.checkBetAmount(50n).ok).toBe(true); // no override → global [1, 1000000]
});

test("round exposure cap rejects a bet that would exceed the bankroll", () => {
  // maxMultiplier 100x, per-bet win cap huge, round exposure cap 1000.
  const r = makeRisk({
    RISK_MAX_MULTIPLIER: "100",
    RISK_MAX_WIN_PER_BET: "1000000000",
    RISK_MAX_ROUND_EXPOSURE: "1000",
  });
  // a 10-unit bet has potential payout 10 × 100 = 1000 → exactly fills the cap
  const first = r.checkRoundExposure(0n, 10n);
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.newExposure).toBe(1000n);
  // any further exposure exceeds the cap → rejected
  const second = r.checkRoundExposure(1000n, 1n);
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.reason).toBe("round_exposure_cap");
});

test("exposure accumulates across multiple bets up to the cap", () => {
  const r = makeRisk({
    RISK_MAX_MULTIPLIER: "10",
    RISK_MAX_WIN_PER_BET: "1000000",
    RISK_MAX_ROUND_EXPOSURE: "300", // 3 bets of potential 100 each
  });
  let exp = 0n;
  for (let i = 0; i < 3; i++) {
    const c = r.checkRoundExposure(exp, 10n); // potential 10×10 = 100
    expect(c.ok).toBe(true);
    if (c.ok) exp = c.newExposure;
  }
  expect(exp).toBe(300n);
  expect(r.checkRoundExposure(exp, 10n).ok).toBe(false); // 4th would exceed
});

// ─────────────────────────────────────────────────────────────────────────────
// assertRiskConfigForMode — the go-live boot guard (operator/real-money mode REFUSES
// to boot on the demo-grade RISK_* defaults unless each ceiling is EXPLICITLY set,
// detected by env PRESENCE not value). Driven via the explicit `env` argument so each
// case is isolated with no process.env mutation; one case below also proves the
// default-arg (process.env) path with full save/restore.
describe("assertRiskConfigForMode (go-live boot guard)", () => {
  const ALL: Record<string, string> = {
    RISK_MAX_WIN_PER_BET: "1000000",
    RISK_MAX_MULTIPLIER: "1000",
    RISK_MAX_ROUND_EXPOSURE: "100000000",
    RISK_MAX_BET: "50000",
  };

  test("internal mode (explicit) + no RISK_* → no throw", () => {
    expect(() => assertRiskConfigForMode({ WALLET_PROVIDER_TYPE: "internal" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  test("mode unset (defaults to internal) + no RISK_* → no throw (the test suite + demo)", () => {
    expect(() => assertRiskConfigForMode({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  test("operator mode + all 4 ceilings UNSET → throws naming every missing key", () => {
    let err: Error | undefined;
    try {
      assertRiskConfigForMode({ WALLET_PROVIDER_TYPE: "operator" } as NodeJS.ProcessEnv);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // The message must name EACH missing ceiling (so the operator knows what to set).
    for (const k of ["RISK_MAX_WIN_PER_BET", "RISK_MAX_MULTIPLIER", "RISK_MAX_ROUND_EXPOSURE", "RISK_MAX_BET"]) {
      expect(err!.message).toContain(k);
    }
    expect(err!.message).toContain("operator"); // echoes the active mode
  });

  test("operator mode + all 4 ceilings SET (any values) → no throw", () => {
    expect(() =>
      assertRiskConfigForMode({ WALLET_PROVIDER_TYPE: "operator", ...ALL } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  // Table-driven: drop EXACTLY ONE ceiling at a time → throws naming only that one,
  // and NOT the three that are present.
  for (const missing of Object.keys(ALL)) {
    test(`operator mode + 3 of 4 set (missing ${missing}) → throws naming only ${missing}`, () => {
      const env: Record<string, string> = { WALLET_PROVIDER_TYPE: "operator", ...ALL };
      delete env[missing];
      let err: Error | undefined;
      try {
        assertRiskConfigForMode(env as NodeJS.ProcessEnv);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err!.message).toContain(missing);
      for (const present of Object.keys(ALL).filter((k) => k !== missing)) {
        expect(err!.message).not.toContain(present);
      }
    });
  }

  test("operator mode + RISK_ALLOW_DEMO_DEFAULTS=true + all UNSET → no throw (the non-prod escape hatch)", () => {
    expect(() =>
      assertRiskConfigForMode({ WALLET_PROVIDER_TYPE: "operator", RISK_ALLOW_DEMO_DEFAULTS: "true" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  test("presence-not-value: explicitly setting the demo value (100000000) in operator mode → no throw", () => {
    // The guard fires on env PRESENCE, not value — an operator who deliberately wants the
    // generous demo-grade ceiling still boots by setting it explicitly.
    expect(() =>
      assertRiskConfigForMode({
        WALLET_PROVIDER_TYPE: "operator",
        RISK_MAX_WIN_PER_BET: "100000000", // the demo default, set on purpose
        RISK_MAX_MULTIPLIER: "1000000",
        RISK_MAX_ROUND_EXPOSURE: "10000000000",
        RISK_MAX_BET: "1000000",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  // Present-but-unparseable values (empty / non-numeric / non-positive) must be treated
  // as MISSING — otherwise envBig/envNum silently fall back to the DEMO default and the
  // guard is defeated. The guard checks presence AND validity (Number(v) > 0).
  test.each([
    ["empty string", ""],
    ["non-numeric", "abc"],
    ["negative", "-5"],
    ["zero", "0"],
  ])("invalid RISK_MAX_BET=%s in operator mode → THROWS (presence+validity)", (_label, bad) => {
    expect(() =>
      assertRiskConfigForMode({
        WALLET_PROVIDER_TYPE: "operator",
        RISK_MAX_WIN_PER_BET: "1000000",
        RISK_MAX_MULTIPLIER: "1000",
        RISK_MAX_ROUND_EXPOSURE: "100000000",
        RISK_MAX_BET: bad,
      } as NodeJS.ProcessEnv),
    ).toThrow(/RISK_MAX_BET/);
  });

  test("default-arg path reads process.env (operator + all set → no throw); env saved/restored", () => {
    const touched = ["WALLET_PROVIDER_TYPE", "RISK_ALLOW_DEMO_DEFAULTS", ...Object.keys(ALL)];
    const saved: Record<string, string | undefined> = {};
    for (const k of touched) saved[k] = process.env[k];
    try {
      delete process.env.RISK_ALLOW_DEMO_DEFAULTS;
      process.env.WALLET_PROVIDER_TYPE = "operator";
      // Missing ceilings → throws via the process.env default arg.
      for (const k of Object.keys(ALL)) delete process.env[k];
      expect(() => assertRiskConfigForMode()).toThrow();
      // Now set them all → passes via the same default arg.
      for (const k of Object.keys(ALL)) process.env[k] = ALL[k];
      expect(() => assertRiskConfigForMode()).not.toThrow();
    } finally {
      for (const k of touched) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  });
});
