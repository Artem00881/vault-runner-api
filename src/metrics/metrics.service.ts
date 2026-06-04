import { Injectable } from "@nestjs/common";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics — the server's "dashboard" (Phase 1.3). Exposes counters a
 * monitor (Grafana) scrapes from GET /metrics.
 *
 * The headline metric for a money game is REALIZED RTP = total payouts / total
 * stakes. It should track the theoretical 97%; a drift is an early warning that
 * money is leaking (bug) or being shorted (the opposite). We expose both the raw
 * totals (so a monitor computes RTP over any window) and a live ratio gauge.
 *
 * THEORETICAL_RTP is informational here (the design target); REALIZED is what we
 * actually paid vs took.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly betsTotal: Counter;
  readonly betsRejected: Counter;
  readonly rgBlocks: Counter; // responsible-gambling blocks by reason (Phase 3 go-live observability)
  readonly stakeTotal: Counter; // Σ stakes (minor units) — RTP denominator
  readonly payoutTotal: Counter; // Σ payouts (minor units) — RTP numerator
  readonly cashoutsTotal: Counter;
  readonly roundsTotal: Counter;
  readonly errorsTotal: Counter;

  readonly wsConnections: Gauge;
  readonly realizedRtp: Gauge;
  // Operator-mode payout backlog (H2): a won cash-out whose operator credit we
  // couldn't confirm sits in status payout_pending until the reconciler clears
  // it. We never abandon it, so a stuck one must be loud + alertable.
  readonly pendingPayouts: Gauge;
  readonly pendingPayoutOldestSeconds: Gauge;
  readonly reservingSlots: Gauge;
  readonly reservingOldestSeconds: Gauge;

  readonly settlementLatency: Histogram;

  // running totals to compute the realized-RTP gauge
  private stakeSum = 0;
  private payoutSum = 0;

  constructor() {
    this.registry.setDefaultLabels({ service: "vault-runner-api" });
    collectDefaultMetrics({ register: this.registry }); // node/process metrics

    const reg = [this.registry];
    this.betsTotal = new Counter({ name: "vaultrun_bets_total", help: "Bets placed", registers: reg });
    this.betsRejected = new Counter({ name: "vaultrun_bets_rejected_total", help: "Bets rejected", labelNames: ["reason"], registers: reg });
    this.rgBlocks = new Counter({ name: "vaultrun_rg_blocks_total", help: "Responsible-gambling blocks by reason (subset of bets_rejected; real-money sessions only)", labelNames: ["reason"], registers: reg });
    this.stakeTotal = new Counter({ name: "vaultrun_stake_minor_total", help: "Total staked (minor units)", registers: reg });
    this.payoutTotal = new Counter({ name: "vaultrun_payout_minor_total", help: "Total paid out (minor units)", registers: reg });
    this.cashoutsTotal = new Counter({ name: "vaultrun_cashouts_total", help: "Successful cash-outs", registers: reg });
    this.roundsTotal = new Counter({ name: "vaultrun_rounds_total", help: "Rounds completed", registers: reg });
    this.errorsTotal = new Counter({ name: "vaultrun_errors_total", help: "Handled errors", labelNames: ["where"], registers: reg });

    this.wsConnections = new Gauge({ name: "vaultrun_ws_connections", help: "Active WS connections", registers: reg });
    this.realizedRtp = new Gauge({ name: "vaultrun_realized_rtp", help: "Realized RTP = payouts/stakes", registers: reg });
    this.pendingPayouts = new Gauge({ name: "vaultrun_pending_payouts", help: "Bets in status payout_pending (operator-mode owed payouts not yet confirmed)", registers: reg });
    this.pendingPayoutOldestSeconds = new Gauge({ name: "vaultrun_pending_payout_oldest_seconds", help: "Age (seconds) of the oldest pending payout by settledAt; 0 if none", registers: reg });
    this.reservingSlots = new Gauge({ name: "vaultrun_reserving_slots", help: "Bets in a transient reservation state (reserving|cancelling); a stuck age = an owed refund the sweep hasn't cleared", registers: reg });
    this.reservingOldestSeconds = new Gauge({ name: "vaultrun_reserving_oldest_seconds", help: "Age (seconds) of the oldest reserving|cancelling slot by createdAt; 0 if none", registers: reg });

    this.settlementLatency = new Histogram({
      name: "vaultrun_settlement_latency_ms",
      help: "Round settlement latency (ms)",
      buckets: [10, 25, 50, 100, 200, 500, 1000],
      registers: reg,
    });
  }

  /** Record a placed bet + its stake (updates realized-RTP denominator). */
  recordBet(stakeMinor: number) {
    this.betsTotal.inc();
    this.stakeTotal.inc(stakeMinor);
    this.stakeSum += stakeMinor;
    this.updateRtp();
  }

  /** Record a payout (cash-out win) — updates realized-RTP numerator. */
  recordPayout(payoutMinor: number) {
    this.cashoutsTotal.inc();
    this.payoutTotal.inc(payoutMinor);
    this.payoutSum += payoutMinor;
    this.updateRtp();
  }

  recordRejected(reason: string) { this.betsRejected.inc({ reason }); }
  /** A responsible-gambling block (reality-check pending / time / loss / wager). Fired
   *  ALONGSIDE recordRejected (kept for back-compat) to give a clean RG-only signal. */
  recordRgBlock(reason: string) { this.rgBlocks.inc({ reason }); }
  recordRound() { this.roundsTotal.inc(); }
  recordError(where: string) { this.errorsTotal.inc({ where }); }
  setWsConnections(n: number) { this.wsConnections.set(n); }
  observeSettlementLatency(ms: number) { this.settlementLatency.observe(ms); }

  /**
   * Reflect the live operator-mode payout backlog (H2). Called each reconcile
   * cycle so the gauges drop to 0 when the backlog clears. `oldestAgeSeconds` is
   * the age of the oldest payout_pending bet by settledAt (0 when count === 0).
   */
  setPendingPayouts(count: number, oldestAgeSeconds: number) {
    this.pendingPayouts.set(count);
    this.pendingPayoutOldestSeconds.set(oldestAgeSeconds);
  }

  /**
   * Reflect the live transient-reservation backlog (reserving|cancelling) — audit
   * Low-4. Called each sweep cycle so the gauges drop to 0 when nothing is stranded.
   * `oldestAgeSeconds` is the age of the oldest such slot by createdAt (0 when none).
   */
  setReservingBacklog(count: number, oldestAgeSeconds: number) {
    this.reservingSlots.set(count);
    this.reservingOldestSeconds.set(oldestAgeSeconds);
  }

  private updateRtp() {
    if (this.stakeSum > 0) this.realizedRtp.set(this.payoutSum / this.stakeSum);
  }

  /** Prometheus exposition text for GET /metrics. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
