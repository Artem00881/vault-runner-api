import { Injectable } from "@nestjs/common";

/**
 * House risk controls (Phase 1.1). Protects the operator's bankroll so no single
 * round can owe more than a configured cap.
 *
 * Limits (minor units / multiplier). Global env defaults here; an operator's
 * per-currency PER-BET limits (min/max stake + single-bet win cap) override them
 * via the optional `limits`/`maxWinPerBet` args (Phase 3 — resolved from
 * Operator.betLimits at launch, carried on the session token + bet row). When no
 * override is passed (internal/guest), behaviour is byte-for-byte the global
 * default. Env overrides:
 *   RISK_MIN_BET, RISK_MAX_BET, RISK_MAX_WIN_PER_BET,
 *   RISK_MAX_MULTIPLIER, RISK_MAX_ROUND_EXPOSURE
 */
export interface RiskLimits {
  minBet: bigint;
  maxBet: bigint;
  maxWinPerBet: bigint; // cap on a single bet's payout
  maxMultiplier: number; // for worst-case exposure math
  maxRoundExposure: bigint; // max total potential payout across a round
}

/** Per-bet override (an operator's per-currency config). A subset of RiskLimits. */
export interface PerBetLimits {
  minBet: bigint;
  maxBet: bigint;
  maxWinPerBet: bigint;
}

function envBig(name: string, def: bigint): bigint {
  const v = process.env[name];
  return v && /^\d+$/.test(v) ? BigInt(v) : def;
}
function envNum(name: string, def: number): number {
  const v = process.env[name];
  return v && !isNaN(Number(v)) ? Number(v) : def;
}

@Injectable()
export class RiskService {
  readonly limits: RiskLimits = {
    minBet: envBig("RISK_MIN_BET", 1n),
    maxBet: envBig("RISK_MAX_BET", 1_000_000n),
    maxWinPerBet: envBig("RISK_MAX_WIN_PER_BET", 100_000_000n), // demo: generous
    maxMultiplier: envNum("RISK_MAX_MULTIPLIER", 1_000_000),
    maxRoundExposure: envBig("RISK_MAX_ROUND_EXPOSURE", 10_000_000_000n),
  };

  /** Validate a single bet's stake against min/max — the per-currency override
   *  (operator config) REPLACES the global window when passed, else the global
   *  house defaults. (Unlike capPayout's win cap, which INTERSECTS to ≤ global: an
   *  over-global stake still pays out only up to the global maxWinPerBet and is
   *  bounded by the round-exposure breaker, so no money is created.) */
  checkBetAmount(
    amount: bigint,
    limits: Pick<PerBetLimits, "minBet" | "maxBet"> = this.limits,
  ): { ok: true } | { ok: false; reason: string } {
    if (amount < limits.minBet || amount > limits.maxBet) {
      return { ok: false, reason: "invalid_amount" };
    }
    return { ok: true };
  }

  /**
   * Worst-case potential payout of a bet = the most the house could owe:
   * min(amount × maxMultiplier, maxWinPerBet). GLOBAL by design — it feeds only
   * the round-exposure circuit-breaker (a currency-agnostic house safeguard), so
   * it intentionally does NOT take a per-currency override.
   */
  potentialPayout(amount: bigint): bigint {
    const uncapped = amount * BigInt(this.limits.maxMultiplier);
    return uncapped < this.limits.maxWinPerBet ? uncapped : this.limits.maxWinPerBet;
  }

  /**
   * Would adding `amount` to a round whose committed exposure is
   * `currentExposure` exceed the round cap? Reject the bet BEFORE the round runs
   * if so (the circuit breaker for bankroll). GLOBAL/house-level.
   *
   * TODO(phase-later): per-currency exposure caps / FX. The round is shared across
   * operators AND currencies; you can't sum mixed-currency worst-case payouts
   * (EUR + BTC + USDT) into one cap without exchange rates. So this stays a single
   * currency-agnostic minor-unit house safeguard for now (the live demo is
   * single-currency; per-currency PER-BET limits above are the Phase-3 win).
   */
  checkRoundExposure(
    currentExposure: bigint,
    amount: bigint,
  ): { ok: true; newExposure: bigint } | { ok: false; reason: string } {
    const newExposure = currentExposure + this.potentialPayout(amount);
    if (newExposure > this.limits.maxRoundExposure) {
      return { ok: false, reason: "round_exposure_cap" };
    }
    return { ok: true, newExposure };
  }

  /** Clamp an actual payout to the per-bet win cap — the bet's per-currency cap
   *  (operator config) or the global house cap when none is passed. The effective
   *  cap NEVER exceeds the GLOBAL house cap: the round-exposure breaker reserves
   *  against the global maxWinPerBet, so a per-currency cap ABOVE it would
   *  under-reserve the bankroll (money-path audit HIGH) — clamp it down. */
  capPayout(payout: bigint, maxWinPerBet: bigint = this.limits.maxWinPerBet): bigint {
    const cap = maxWinPerBet < this.limits.maxWinPerBet ? maxWinPerBet : this.limits.maxWinPerBet;
    return payout > cap ? cap : payout;
  }
}
