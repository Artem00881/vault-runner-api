import { Injectable } from "@nestjs/common";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { BUILD_VERSION, BUILD_COMMIT } from "../common/build-info";

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
  // Significant-event audit-log write failures (F-058). The audit write is BEST-EFFORT
  // (it must never break a money/operator action), so a failure increments this instead
  // of throwing — a non-zero rate means the immutable audit trail is dropping events.
  readonly auditEventWriteFailures: Counter;
  // Salt-oracle could not serve a committed block-hash salt (audit H3). reason =
  // commit_failed | salt_not_ready; mode = strict (real-money: the engine STALLS) |
  // fallback (demo/play-money: a transparent random salt was substituted). A non-zero
  // strict rate means a real-money node is stalling on the oracle.
  readonly fairnessSaltFallback: Counter;
  // GDPR erasure-as-anonymization (F-065): one increment per player anonymized in place
  // (PII scrubbed; money records retained). A privacy-ops signal — lets a dashboard show
  // erasure requests are being actioned without exposing who.
  readonly playerAnonymizeTotal: Counter;

  readonly wsConnections: Gauge;
  readonly realizedRtp: Gauge;
  // ---- HA / engine-stall observability (audit H5 / F-050) ----
  // Is THIS node the engine leader right now (1) or a follower (0). Labelled by node so a
  // multi-node scrape shows exactly one leader; the leadership-flap alert watches the change
  // counter below, this gauge is the at-a-glance "who leads".
  readonly engineLeader: Gauge;
  // Unix TIMESTAMP (seconds) of the last COMPLETED round. A timestamp (not a since-restart
  // counter) is restart-robust: `time() - this` is the true seconds-since-last-round even
  // across a container restart, so the leader-loop-liveness alert can't be reset by a bounce.
  readonly engineLastRoundTimestampSeconds: Gauge;
  // Leadership transitions on this node (acquire + loss). A non-trivial rate = leadership
  // FLAPPING (a node repeatedly winning/losing the lock) — the leadership-flap alert.
  readonly engineLeadershipChangesTotal: Counter;
  // Operator-mode payout backlog (H2): a won cash-out whose operator credit we
  // couldn't confirm sits in status payout_pending until the reconciler clears
  // it. We never abandon it, so a stuck one must be loud + alertable.
  readonly pendingPayouts: Gauge;
  readonly pendingPayoutOldestSeconds: Gauge;
  readonly reservingSlots: Gauge;
  readonly reservingOldestSeconds: Gauge;

  readonly settlementLatency: Histogram;

  // Build/version traceability (F-059). A constant gauge (value 1) whose LABELS carry
  // the running commit + version, so a scrape (or a Grafana table) tells you exactly
  // which build a node is on — the cert ask "trace a live node back to a git commit".
  readonly buildInfo: Gauge;

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
    this.auditEventWriteFailures = new Counter({ name: "vaultrun_audit_event_write_failures_total", help: "Significant-event audit-log writes that failed (best-effort; the action still proceeded)", registers: reg });
    this.fairnessSaltFallback = new Counter({ name: "vaultrun_fairness_salt_fallback_total", help: "Salt-oracle could not serve a committed block-hash salt (random fallback or strict stall)", labelNames: ["reason", "mode"], registers: reg });
    this.playerAnonymizeTotal = new Counter({ name: "vaultrun_player_anonymize_total", help: "Players anonymized in place (GDPR erasure-as-anonymization, F-065; money records retained)", registers: reg });

    this.wsConnections = new Gauge({ name: "vaultrun_ws_connections", help: "Active WS connections", registers: reg });
    this.realizedRtp = new Gauge({ name: "vaultrun_realized_rtp", help: "Realized RTP = payouts/stakes", registers: reg });
    // HA / engine-stall observability (F-050).
    this.engineLeader = new Gauge({ name: "vaultrun_engine_leader", help: "1 if this node is the engine leader, 0 if a follower", labelNames: ["node"], registers: reg });
    this.engineLastRoundTimestampSeconds = new Gauge({ name: "vaultrun_engine_last_round_timestamp_seconds", help: "Unix timestamp (s) of the last completed round; restart-robust — alert on time()-this", registers: reg });
    this.engineLeadershipChangesTotal = new Counter({ name: "vaultrun_engine_leadership_changes_total", help: "Engine leadership transitions on this node (acquire/loss); a rate>0 = leadership flapping", labelNames: ["node", "event"], registers: reg });
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

    // Build-info gauge (F-059): the metric value is always 1; the running build is
    // carried in the labels. GIT_SHA/version default to "unknown" when the image was
    // built without --build-arg GIT_SHA (behaviour identical to before this fix).
    this.buildInfo = new Gauge({
      name: "vaultrun_build_info",
      help: "Build info (value always 1); the running commit + version are in the labels",
      labelNames: ["commit", "version"],
      registers: reg,
    });
    this.buildInfo.set({ commit: BUILD_COMMIT(), version: BUILD_VERSION }, 1);

    // F-050: seed the last-round timestamp to BOOT time so `time() - this` is small at boot
    // (the engine legitimately takes a few seconds to complete its first round) — a 0 default
    // would read as "stalled for ~55 years" and false-trip EngineStallTimestamp before the
    // first round. enterCompleted() then stamps the real completion time each round.
    this.engineLastRoundTimestampSeconds.set(Date.now() / 1000);
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

  /** A salt-oracle fallback/stall (audit H3). mode=strict → real-money node stalled;
   *  mode=fallback → demo/play-money substituted a random salt. */
  recordSaltFallback(reason: "commit_failed" | "salt_not_ready", mode: "strict" | "fallback") { this.fairnessSaltFallback.inc({ reason, mode }); }
  /** A player was anonymized in place (GDPR erasure-as-anonymization, F-065). */
  recordPlayerAnonymize() { this.playerAnonymizeTotal.inc(); }
  recordRejected(reason: string) { this.betsRejected.inc({ reason }); }
  /** A responsible-gambling block (reality-check pending / time / loss / wager). Fired
   *  ALONGSIDE recordRejected (kept for back-compat) to give a clean RG-only signal. */
  recordRgBlock(reason: string) { this.rgBlocks.inc({ reason }); }
  recordRound() {
    this.roundsTotal.inc();
    // F-050: stamp the wall-clock time of this completed round so the leader-loop-liveness
    // alert measures `time() - vaultrun_engine_last_round_timestamp_seconds` (restart-robust).
    this.engineLastRoundTimestampSeconds.set(Date.now() / 1000);
  }
  recordError(where: string) { this.errorsTotal.inc({ where }); }
  /** Reflect this node's engine leadership (F-050): 1 leader / 0 follower, and count the
   *  transition so the leadership-flap alert can watch a rate. event = acquired | lost. */
  setEngineLeader(node: string, leader: boolean) {
    this.engineLeader.set({ node }, leader ? 1 : 0);
    this.engineLeadershipChangesTotal.inc({ node, event: leader ? "acquired" : "lost" });
  }
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
