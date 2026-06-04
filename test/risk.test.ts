import { test, expect } from "bun:test";
import { RiskService } from "../src/game/risk.service";

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
