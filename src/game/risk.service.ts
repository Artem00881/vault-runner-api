import { Injectable } from "@nestjs/common";

/**
 * House risk controls (Phase 1.1). Protects the operator's bankroll so no single
 * round can owe more than a configured cap.
 *
 * Limits (minor units / multiplier). Demo defaults here; in operator mode these
 * come per-currency from the operator config (wired later). Env overrides:
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

  /** Validate a single bet's stake against min/max. */
  checkBetAmount(amount: bigint): { ok: true } | { ok: false; reason: string } {
    if (amount < this.limits.minBet || amount > this.limits.maxBet) {
      return { ok: false, reason: "invalid_amount" };
    }
    return { ok: true };
  }

  /**
   * Worst-case potential payout of a bet = the most the house could owe:
   * min(amount × maxMultiplier, maxWinPerBet). The per-bet win cap also bounds
   * the actual payout at cash-out (see capPayout).
   */
  potentialPayout(amount: bigint): bigint {
    const uncapped = amount * BigInt(this.limits.maxMultiplier);
    return uncapped < this.limits.maxWinPerBet ? uncapped : this.limits.maxWinPerBet;
  }

  /**
   * Would adding `amount` to a round whose committed exposure is
   * `currentExposure` exceed the round cap? Reject the bet BEFORE the round runs
   * if so (the circuit breaker for bankroll).
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

  /** Clamp an actual payout to the per-bet win cap (house safeguard). */
  capPayout(payout: bigint): bigint {
    return payout > this.limits.maxWinPerBet ? this.limits.maxWinPerBet : payout;
  }
}
