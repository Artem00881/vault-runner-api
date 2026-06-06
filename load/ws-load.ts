/**
 * Sharded Socket.IO load + latency harness for Vault Run (Phase 4.4).
 *
 * WHY a custom harness (not Artillery/k6): the money path is phase-driven over
 * Socket.IO (auth → wait for `betting` → `place_bet` → time the ack → on crash,
 * time `bet_busted`). We already depend on `socket.io-client`; a bespoke loop
 * gives full control of that flow and exact per-action timing off the ack.
 *
 * WHY worker_threads: one Node/Bun event loop can't keep ~10k sockets actively
 * generating without the GENERATOR itself becoming the bottleneck (and then you're
 * measuring your own loop lag, not the server). We shard CLIENTS across WORKERS
 * (node:worker_threads — no new dependency). Each worker self-monitors event-loop
 * lag and marks the run "suspect" if its own loop is starved, so a bad number from
 * an overloaded generator can't be mistaken for a server SLA failure.
 *
 * GROUND TRUTH: client-observed numbers are a lower bound (they include client +
 * network). For the real settlement SLA, pass `--scrape-metrics` (or
 * SCRAPE_METRICS=1) to also GET /metrics at start+end and print the SERVER-side
 * settlement p99 + ws_connections gauge next to the client numbers.
 *
 * Inter-tick gap tracking is the FAILOVER hook for 4.5: each worker records the
 * gap between consecutive `multiplier_update`s; a long gap straddling a leader
 * SIGKILL is the failover window. Here it just surfaces tick starvation under load.
 *
 * ENV KNOBS:
 *   BASE_URL          (http://localhost:3001)  API base
 *   CLIENTS           (200)   total sockets across all workers (FIXED-N mode)
 *   WORKERS           (auto)  generator workers (default min(CLIENTS, cpus, 8))
 *   DURATION_MS       (30000) steady-state run length after warmup (hold at target)
 *   BET_RATE          (0.5)   fraction of clients that bet each betting window
 *
 * RAMPING MODE (4.5c.3 calibration — find the per-node degradation knee):
 *   RAMP_TO           (0)     >0 → RAMP mode: grow connected sockets 0→RAMP_TO over
 *                             RAMP_SECONDS, then hold DURATION_MS. RAMP_TO is the
 *                             ceiling (overrides CLIENTS). In RAMP mode the orchestrator
 *                             prints a LIVE time-series (elapsed, ws_connections gauge,
 *                             server settlement p99, inter-tick max, loop-lag) every
 *                             SAMPLE_EVERY_MS so you can SEE p99 / tick-gap degrade as
 *                             concurrency climbs — that inflection is capacity/node.
 *   RAMP_SECONDS      (120)   ramp duration; clients arrive ~linearly over this window.
 *   SAMPLE_EVERY_MS   (5000)  live-sample cadence in RAMP mode (needs SCRAPE_METRICS for
 *                             the server p99 column; client-side cols always print).
 *   BET_AMOUNT        (50)    stake (minor units)
 *   CASHOUT_AT        (1.5)   auto-cashout target; <=1 disables (ride to bust)
 *   ACK_TIMEOUT_MS    (5000)  per-action socket.io ack timeout
 *   AUTH_CONCURRENCY  (50)    max in-flight guest-auth HTTP calls per worker (ramp)
 *   RAW_SAMPLES       (0)     keep up to N raw latency samples per action (debug)
 *   METRICS_TOKEN     ()      bearer for /metrics if the server locks it (H5)
 *   SCRAPE_METRICS    (0)     1/true → scrape /metrics at start+end (or pass --scrape-metrics)
 *   LAG_WARN_MS       (50)    per-worker event-loop-lag warn threshold
 *   TICK_GAP_WARN_MS  (1000)  inter-tick-gap warn threshold (failover hook)
 *
 * AUTH MODES (4.5c.3):
 *   AUTH_MODE         (guest) "guest" → POST /api/auth/guest (internal play-money wallet);
 *                             "operator" → mint a one-time launch token signed with the
 *                             operator's secret, exchange it at POST /api/operator/launch
 *                             for a play token, handshake as kind:"operator" so settlement
 *                             routes to the operator wallet (the SeamlessOperatorWallet HTTP
 *                             path — the SETTLEMENT-SLA worst case). Each client gets a
 *                             distinct synthetic playerId so they don't share an operator
 *                             balance. Requires an Operator row whose walletApiUrl points at
 *                             load/operator-wallet-stub.ts (see load/README.md).
 *   OPERATOR_CODE     ()      operator `code` to launch under (AUTH_MODE=operator)
 *   OPERATOR_CURRENCY (DEMO)  currency for the operator launch (must be in op.currencies)
 *   PLAYER_PREFIX     (load)  synthetic operator playerId prefix → `${prefix}-w<wkr>-<i>`
 *   This worker mints launch tokens itself via LaunchTokenService (signs with the
 *   operator's launchSecret from the DB), so the operator-mode harness needs DATABASE_URL +
 *   JWT_SECRET in its env too (same as the server). Guest mode needs neither.
 *
 * RUN:
 *   BASE_URL=http://localhost:3001 CLIENTS=100 DURATION_MS=25000 BET_RATE=0.5 \
 *     CASHOUT_AT=1.3 bun load/ws-load.ts
 */
import { Worker, isMainThread, parentPort, workerData, threadId } from "node:worker_threads";
import os from "node:os";

// ---------------------------------------------------------------------------
// Config (parsed once on the main thread, passed to workers via workerData).
// ---------------------------------------------------------------------------
function buildConfig() {
  // RAMP mode: RAMP_TO is the ceiling and OVERRIDES CLIENTS as the target socket count.
  const RAMP_TO = Number(process.env.RAMP_TO ?? 0);
  const RAMP_SECONDS = Number(process.env.RAMP_SECONDS ?? 120);
  const SAMPLE_EVERY_MS = Number(process.env.SAMPLE_EVERY_MS ?? 5000);
  const RAMP = RAMP_TO > 0;
  // In RAMP mode the effective client total IS the ramp ceiling.
  const CLIENTS = RAMP ? RAMP_TO : Number(process.env.CLIENTS ?? 200);
  const cpuCount = os.cpus().length || 4;
  const WORKERS = Math.max(1, Number(process.env.WORKERS ?? Math.min(CLIENTS, cpuCount, 8)));
  return {
    BASE_URL: process.env.BASE_URL ?? "http://localhost:3001",
    CLIENTS,
    WORKERS,
    RAMP,
    RAMP_TO,
    RAMP_SECONDS,
    SAMPLE_EVERY_MS,
    DURATION_MS: Number(process.env.DURATION_MS ?? 30000),
    BET_RATE: Number(process.env.BET_RATE ?? 0.5),
    BET_AMOUNT: Number(process.env.BET_AMOUNT ?? 50),
    CASHOUT_AT: Number(process.env.CASHOUT_AT ?? 1.5),
    ACK_TIMEOUT_MS: Number(process.env.ACK_TIMEOUT_MS ?? 5000),
    AUTH_CONCURRENCY: Number(process.env.AUTH_CONCURRENCY ?? 50),
    RAW_SAMPLES: Number(process.env.RAW_SAMPLES ?? 0),
    METRICS_TOKEN: process.env.METRICS_TOKEN ?? "",
    SCRAPE_METRICS:
      process.argv.includes("--scrape-metrics") ||
      /^(1|true|yes)$/i.test(process.env.SCRAPE_METRICS ?? ""),
    LAG_WARN_MS: Number(process.env.LAG_WARN_MS ?? 50),
    TICK_GAP_WARN_MS: Number(process.env.TICK_GAP_WARN_MS ?? 1000),
    // Auth mode (4.5c.3). "guest" (default) → /api/auth/guest internal wallet.
    // "operator" → operator launch-token → play token (operator-wallet settlement path).
    AUTH_MODE: (process.env.AUTH_MODE ?? "guest").toLowerCase() as "guest" | "operator",
    OPERATOR_CODE: process.env.OPERATOR_CODE ?? "",
    OPERATOR_CURRENCY: process.env.OPERATOR_CURRENCY ?? "DEMO",
    PLAYER_PREFIX: process.env.PLAYER_PREFIX ?? "load",
  };
}
type Config = ReturnType<typeof buildConfig>;

// ---------------------------------------------------------------------------
// Compact log-ish histogram: fixed buckets in ms, mergeable across workers as a
// plain array of counts (so we can sum them in the orchestrator). Percentiles are
// the bucket UPPER bound — i.e. an upper-bound estimate, conservative for an SLA.
// ---------------------------------------------------------------------------
const BUCKETS_MS = [
  1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 200, 300, 500, 800, 1300, 2100, 3400, 5500, Infinity,
];
function emptyHist(): number[] {
  return new Array(BUCKETS_MS.length).fill(0);
}
function histObserve(h: number[], ms: number) {
  for (let i = 0; i < BUCKETS_MS.length; i++) {
    if (ms <= BUCKETS_MS[i]) {
      h[i]++;
      return;
    }
  }
  h[h.length - 1]++;
}
function histMerge(into: number[], from: number[]) {
  for (let i = 0; i < into.length; i++) into[i] += from[i] ?? 0;
}
function histCount(h: number[]): number {
  return h.reduce((a, b) => a + b, 0);
}
function histPercentile(h: number[], p: number): number {
  const total = histCount(h);
  if (total === 0) return 0;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < h.length; i++) {
    cum += h[i];
    if (cum >= target) return BUCKETS_MS[i];
  }
  return BUCKETS_MS[BUCKETS_MS.length - 1];
}

type ActionName = "place_bet" | "cash_out" | "bet_busted";
interface WorkerReport {
  threadId: number;
  hist: Record<ActionName, number[]>;
  counts: {
    connected: number;
    connectErrors: number;
    authErrors: number;
    betAccepted: number;
    betRejected: number;
    cashoutAccepted: number;
    cashoutRejected: number;
    busted: number;
    ackTimeouts: number;
    ticks: number;
  };
  rejectReasons: Record<string, number>;
  tickGapHist: number[]; // inter-tick gap distribution (ms)
  maxTickGapMs: number;
  loopLagMaxMs: number;
  suspect: boolean; // generator loop was starved → numbers from this worker are unreliable
  raw?: Record<ActionName, number[]>;
}

// ===========================================================================
// WORKER ROLE
// ===========================================================================
async function runWorker(cfg: Config, sliceSize: number, sliceIndex: number) {
  // socket.io-client is a devDependency; load it lazily inside the worker.
  const { io } = (await import("socket.io-client")) as typeof import("socket.io-client");

  const hist: Record<ActionName, number[]> = {
    place_bet: emptyHist(),
    cash_out: emptyHist(),
    bet_busted: emptyHist(),
  };
  const raw: Record<ActionName, number[]> = { place_bet: [], cash_out: [], bet_busted: [] };
  const counts = {
    connected: 0,
    connectErrors: 0,
    authErrors: 0,
    betAccepted: 0,
    betRejected: 0,
    cashoutAccepted: 0,
    cashoutRejected: 0,
    busted: 0,
    ackTimeouts: 0,
    ticks: 0,
  };
  const rejectReasons: Record<string, number> = {};
  const tickGapHist = emptyHist();
  let maxTickGapMs = 0;
  let loopLagMaxMs = 0;
  let suspect = false;
  let stop = false;

  // Recent-window samples for the LIVE ramp series (sliding, capped) so the orchestrator
  // can show p99 climbing in real time (the cumulative hist hides the inflection).
  const recent: Record<"place_bet" | "cash_out", number[]> = { place_bet: [], cash_out: [] };
  const RECENT_CAP = 2000;
  const obs = (a: ActionName, ms: number) => {
    histObserve(hist[a], ms);
    if (cfg.RAW_SAMPLES > 0 && raw[a].length < cfg.RAW_SAMPLES) raw[a].push(ms);
    if (a === "place_bet" || a === "cash_out") {
      const r = recent[a];
      r.push(ms);
      if (r.length > RECENT_CAP) r.shift();
    }
  };
  function recentP99(a: "place_bet" | "cash_out"): number {
    const r = recent[a];
    if (r.length === 0) return 0;
    const sorted = [...r].sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }

  // Per-worker event-loop-lag guard: schedule a 20ms timer; the overshoot beyond
  // 20ms is loop lag. If sustained high, this generator is starved → mark suspect.
  let lagTimer: ReturnType<typeof setInterval> | null = null;
  {
    let last = Date.now();
    let highStreak = 0;
    lagTimer = setInterval(() => {
      const now = Date.now();
      const lag = now - last - 20;
      last = now;
      if (lag > loopLagMaxMs) loopLagMaxMs = lag;
      if (lag > cfg.LAG_WARN_MS) {
        highStreak++;
        if (highStreak >= 5) suspect = true; // sustained starvation
      } else {
        highStreak = 0;
      }
    }, 20);
  }

  // RAMP-mode live snapshot: emit a lightweight per-window summary to the orchestrator
  // so it can print the degradation series. windowTickGapMax/windowLoopLagMax reset each
  // emit so the series reflects the CURRENT window, not the all-time max.
  let windowTickGapMax = 0;
  let windowLoopLagMax = 0;
  let snapTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.RAMP) {
    let lastLag = Date.now();
    snapTimer = setInterval(() => {
      const lag = Date.now() - lastLag - cfg.SAMPLE_EVERY_MS;
      lastLag = Date.now();
      if (lag > windowLoopLagMax) windowLoopLagMax = lag;
      parentPort?.postMessage({
        type: "snap",
        threadId,
        launched,
        connected: counts.connected,
        betAccepted: counts.betAccepted,
        ackTimeouts: counts.ackTimeouts,
        placeP99: recentP99("place_bet"),
        cashP99: recentP99("cash_out"),
        windowTickGapMax,
        loopLagMax: loopLagMaxMs,
        suspect,
      });
      windowTickGapMax = 0;
      windowLoopLagMax = 0;
    }, cfg.SAMPLE_EVERY_MS);
  }

  // Bounded-concurrency guest auth so a worker owning thousands of sockets ramps
  // instead of opening every HTTP+WS at once (which would self-DoS the generator).
  // One retry with backoff: guest auth is a multi-row DB write; under a startup
  // burst a transient failure shouldn't permanently drop a client (which would
  // understate concurrency). A persistent failure still counts as authError.
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function authGuest(): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${cfg.BASE_URL}/api/auth/guest`, { method: "POST" });
        if (r.ok) {
          const j = (await r.json()) as { token?: string };
          if (j.token) return j.token;
        }
      } catch {
        /* transient — retry once */
      }
      if (attempt === 0) await sleepMs(100 + Math.random() * 400);
    }
    return null;
  }

  // ---- OPERATOR auth (4.5c.3): mint a one-time launch token (signed with the operator's
  // own launchSecret via the production LaunchTokenService), exchange it at the real
  // POST /api/operator/launch endpoint for a play token, return that. This drives the
  // SeamlessOperatorWallet HTTP settlement path (settlement-SLA worst case). The launch
  // token is one-time (jti consumed on session create), so we mint one per client. The
  // LaunchTokenService + Prisma are loaded lazily, ONCE per worker, so guest mode (the
  // common case) never pulls NestJS/Prisma into the generator.
  let opMint:
    | null
    | ((playerId: string) => Promise<string>) = null;
  let opSeq = 0;
  async function ensureOperatorMint() {
    if (opMint) return;
    if (!cfg.OPERATOR_CODE) throw new Error("AUTH_MODE=operator requires OPERATOR_CODE");
    const { PrismaClient } = await import("@prisma/client");
    const { JwtService } = await import("@nestjs/jwt");
    const { LaunchTokenService } = await import("../src/operator/launch-token.service");
    const prisma = new PrismaClient();
    const op = await prisma.operator.findUnique({ where: { code: cfg.OPERATOR_CODE } });
    if (!op) throw new Error(`no operator with code "${cfg.OPERATOR_CODE}" — provision it first`);
    if (!op.currencies.some((c: string) => c.toUpperCase() === cfg.OPERATOR_CURRENCY.toUpperCase())) {
      throw new Error(`currency ${cfg.OPERATOR_CURRENCY} not in operator.currencies [${op.currencies.join(",")}]`);
    }
    const svc = new LaunchTokenService(new JwtService({}) as any, prisma as any);
    opMint = (playerId: string) =>
      svc.issue({ operatorId: op.id, playerId, currency: cfg.OPERATOR_CURRENCY, locale: "en" });
  }
  async function authOperator(): Promise<string | null> {
    // Distinct synthetic player per client so they don't share one operator balance.
    const playerId = `${cfg.PLAYER_PREFIX}-w${threadId}-${++opSeq}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const launch = await opMint!(playerId); // launchSecret-signed, one-time
        const r = await fetch(`${cfg.BASE_URL}/api/operator/launch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: launch }),
        });
        if (r.ok) {
          const j = (await r.json()) as { token?: string };
          if (j.token) return j.token; // the PLAY token for the WS handshake
        }
      } catch {
        /* transient — retry once */
      }
      if (attempt === 0) await sleepMs(100 + Math.random() * 400);
    }
    return null;
  }
  const authClient = cfg.AUTH_MODE === "operator" ? authOperator : authGuest;

  // One simulated player on one socket. Returns the socket so we can close it.
  function startClient(token: string) {
    const socket = io(cfg.BASE_URL, {
      transports: ["websocket"],
      reconnection: false,
      auth: { token },
      timeout: cfg.ACK_TIMEOUT_MS,
    });

    // Per-socket round bookkeeping.
    let lastBetRound: string | null = null; // betting window we've bet this round
    let activeRound: string | null = null; // round we currently hold a live bet on
    let cashedThisRound = false;
    let lastTickAt = 0;
    let lastTickRoundId: string | null = null; // for same-round gap detection
    let crashSeenAt = 0; // when we saw the crash for the round we hold a bet on
    const willBet = Math.random() < cfg.BET_RATE; // this client bets each window?

    socket.on("connect", () => {
      counts.connected++;
    });
    socket.on("connect_error", () => {
      counts.connectErrors++;
    });

    socket.on("round_state", (s: any) => {
      if (!s || stop) return;
      if (s.phase === "betting" && willBet && s.roundId !== lastBetRound) {
        lastBetRound = s.roundId;
        cashedThisRound = false;
        const payload: any = { panel: "A", amount: cfg.BET_AMOUNT };
        if (cfg.CASHOUT_AT > 1) payload.autoCashout = cfg.CASHOUT_AT;
        const t0 = Date.now();
        // socket.io ack with timeout — the gateway handler returns `r` to the ack.
        socket
          .timeout(cfg.ACK_TIMEOUT_MS)
          .emit("place_bet", payload, (err: unknown, r: any) => {
            const dt = Date.now() - t0;
            if (err) {
              counts.ackTimeouts++;
              return;
            }
            obs("place_bet", dt);
            if (r?.ok) {
              counts.betAccepted++;
              activeRound = s.roundId;
            } else {
              counts.betRejected++;
              const reason = r?.reason ?? "unknown";
              rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
            }
          });
      }
    });

    // Inter-tick gap (failover hook + tick-starvation signal).
    socket.on("multiplier_update", (m: any) => {
      counts.ticks++;
      const now = Date.now();
      if (lastTickAt > 0) {
        const gap = now - lastTickAt;
        histObserve(tickGapHist, gap); // ALL gaps (failover hook) — incl. between-round
        if (gap > maxTickGapMs) maxTickGapMs = gap;
        // The LIVE/knee tick-starvation signal is SAME-ROUND gaps only: between rounds there
        // are NO ticks for the whole crashed+settling+betting+waiting window (~10s+), which is
        // EXPECTED and would otherwise masquerade as a stall. A same-round gap >> ~120ms IS the
        // engine's onTick loop or the fan-out falling behind under load (the real signal).
        if (lastTickRoundId === m.roundId && gap > windowTickGapMax) windowTickGapMax = gap;
      }
      lastTickAt = now;
      lastTickRoundId = m.roundId;

      // Manual cash-out path: if no auto-cashout is configured, cash out the first
      // time we cross a small target so the cash_out ack leg is exercised too.
      if (
        cfg.CASHOUT_AT <= 1 &&
        activeRound === m.roundId &&
        !cashedThisRound &&
        m.multiplier >= 1.2
      ) {
        cashedThisRound = true;
        const t0 = Date.now();
        socket.timeout(cfg.ACK_TIMEOUT_MS).emit("cash_out", { panel: "A" }, (err: unknown, r: any) => {
          const dt = Date.now() - t0;
          if (err) {
            counts.ackTimeouts++;
            return;
          }
          // Time the manual cash_out ACK leg (request→response). The accept COUNT is
          // taken from the `cashout_accepted` push handler below (fires for both manual
          // and server-auto cash-outs) so we don't double-count the manual path.
          obs("cash_out", dt);
          if (!r?.ok) counts.cashoutRejected++;
        });
      }
    });

    // Cash-out confirmation push — fires for BOTH manual cash-outs and server-driven
    // auto-cashout. Single source of truth for the accepted count (no ack double-count).
    socket.on("cashout_accepted", () => {
      counts.cashoutAccepted++;
      cashedThisRound = true;
      activeRound = null; // a cashed bet won't bust → stop the bet_busted timer for it
    });

    socket.on("round_crashed", (p: any) => {
      // Mark when the crash for OUR active round was observed. NOTE: bet_busted is NOT
      // emitted now — the engine holds a deliberate `crashed`(2.5s)+`settling`(0.5s)
      // pacing window before settleRound runs, so the client crash→busted gap is
      // DOMINATED by that pacing, NOT settlement compute. The real settlement SLA is
      // the SERVER-side vaultrun_settlement_latency_ms (--scrape-metrics); this client
      // leg only proves the fan-out reaches every client. Labeled accordingly below.
      if (activeRound && p?.roundId === activeRound) crashSeenAt = Date.now();
    });

    socket.on("bet_busted", () => {
      counts.busted++;
      // Settlement fan-out latency for a losing bet: crash seen → bet_busted here.
      if (crashSeenAt > 0) {
        obs("bet_busted", Date.now() - crashSeenAt);
        crashSeenAt = 0;
      }
      activeRound = null;
    });

    return socket;
  }

  // Ramp up this worker's slice with bounded auth concurrency.
  const sockets: any[] = [];
  let launched = 0;
  // FIXED-N mode: open the whole slice as fast as AUTH_CONCURRENCY allows, then hold.
  async function rampUpFast() {
    let inFlight = 0;
    let idx = 0;
    return new Promise<void>((resolve) => {
      const pump = () => {
        while (inFlight < cfg.AUTH_CONCURRENCY && idx < sliceSize && !stop) {
          idx++;
          inFlight++;
          authClient()
            .then((token) => {
              if (token) {
                sockets.push(startClient(token));
                launched++;
              } else {
                counts.authErrors++;
              }
            })
            .finally(() => {
              inFlight--;
              if (idx >= sliceSize && inFlight === 0) resolve();
              else pump();
            });
        }
      };
      pump();
      if (sliceSize === 0) resolve();
    });
  }

  // RAMP mode: release new client-launches at a TARGET RATE so connected sockets grow
  // ~linearly to the slice ceiling over RAMP_SECONDS (the orchestrator prints the live
  // ws_connections/p99 series while this climbs → the degradation knee is visible). Still
  // capped at AUTH_CONCURRENCY in-flight so a transient auth stall can't burst-open. If
  // auth can't keep up with the target rate, the run is RATE-LIMITED by the generator —
  // surfaced as a suspect-style note (launched < ceiling at ramp end).
  async function rampUpPaced() {
    if (sliceSize === 0) return;
    const perSecond = Math.max(0.5, sliceSize / Math.max(1, cfg.RAMP_SECONDS));
    const stepMs = 100; // release cadence
    const perStep = (perSecond * stepMs) / 1000; // fractional clients to release per step
    let credit = 0;
    let started = 0; // launches BEGUN (in-flight + done) — paces against the schedule
    let inFlight = 0;
    const launchOne = () => {
      started++;
      inFlight++;
      authClient()
        .then((token) => {
          if (token) {
            sockets.push(startClient(token));
            launched++;
          } else {
            counts.authErrors++;
          }
        })
        .finally(() => {
          inFlight--;
        });
    };
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (stop || started >= sliceSize) {
          clearInterval(timer);
          resolve();
          return;
        }
        credit += perStep;
        while (credit >= 1 && started < sliceSize && inFlight < cfg.AUTH_CONCURRENCY) {
          credit -= 1;
          launchOne();
        }
      }, stepMs);
    });
    // Drain any still-in-flight auths from the final step.
    while (inFlight > 0 && !stop) await sleepMs(50);
  }
  const rampUp = cfg.RAMP ? rampUpPaced : rampUpFast;

  // Operator mode: stand up the launch-token minter once before ramping (fail loud here
  // if the operator/currency is misconfigured, rather than silently authError every client).
  if (cfg.AUTH_MODE === "operator" && sliceSize > 0) {
    try {
      await ensureOperatorMint();
    } catch (e: any) {
      parentPort?.postMessage({ type: "log", msg: `worker ${threadId} operator-mint setup FAILED: ${e?.message}` });
    }
  }
  parentPort?.postMessage({ type: "log", msg: `worker ${threadId} (slice ${sliceIndex}) ramping ${sliceSize} clients [auth=${cfg.AUTH_MODE}]…` });
  // Stagger workers so all WORKERS don't fire their auth bursts at the same instant
  // (a synchronized thundering herd on the guest-auth DB-write path self-DoSes a
  // single-host run). Jitter proportional to slice index.
  await sleepMs(sliceIndex * 75 + Math.random() * 150);
  const rampStart = Date.now();
  await rampUp();
  parentPort?.postMessage({
    type: "log",
    msg: `worker ${threadId} ramped ${launched}/${sliceSize} clients in ${Date.now() - rampStart}ms`,
  });

  // Listen for the orchestrator's stop signal, then settle briefly so in-flight
  // acks / a final bet_busted land before we snapshot + report.
  await new Promise<void>((resolve) => {
    parentPort?.on("message", (msg: any) => {
      if (msg?.type === "stop") resolve();
    });
  });
  stop = true;
  await new Promise((r) => setTimeout(r, 1500)); // drain in-flight settlement events
  if (lagTimer) clearInterval(lagTimer);
  if (snapTimer) clearInterval(snapTimer);

  // Maxed tick gap → suspect only flags the GENERATOR loop, not the server; report
  // the tick gap raw and let the orchestrator decide what it means.
  const report: WorkerReport = {
    threadId,
    hist,
    counts,
    rejectReasons,
    tickGapHist,
    maxTickGapMs,
    loopLagMaxMs,
    suspect,
    raw: cfg.RAW_SAMPLES > 0 ? raw : undefined,
  };
  parentPort?.postMessage({ type: "report", report });
  for (const s of sockets) s.close();
}

// ===========================================================================
// ORCHESTRATOR ROLE (main thread)
// ===========================================================================
async function scrapeMetrics(cfg: Config): Promise<Record<string, number>> {
  const headers: Record<string, string> = {};
  if (cfg.METRICS_TOKEN) headers.authorization = `Bearer ${cfg.METRICS_TOKEN}`;
  const out: Record<string, number> = {};
  try {
    const r = await fetch(`${cfg.BASE_URL}/metrics`, { headers });
    if (!r.ok) {
      out.__error = r.status;
      return out;
    }
    const text = await r.text();
    // Parse the settlement histogram buckets + count/sum, the ws_connections gauge,
    // and rounds_total so we can print server-side p99 alongside the client number.
    const lines = text.split("\n");
    const buckets: { le: number; v: number }[] = [];
    for (const line of lines) {
      if (line.startsWith("#")) continue;
      let m = line.match(/^vaultrun_settlement_latency_ms_bucket\{[^}]*le="([^"]+)"[^}]*\}\s+([0-9.e+]+)/);
      if (m) {
        buckets.push({ le: m[1] === "+Inf" ? Infinity : Number(m[1]), v: Number(m[2]) });
        continue;
      }
      m = line.match(/^vaultrun_settlement_latency_ms_count\b[^\s]*\s+([0-9.e+]+)/);
      if (m) out.settlement_count = Number(m[1]);
      m = line.match(/^vaultrun_settlement_latency_ms_sum\b[^\s]*\s+([0-9.e+]+)/);
      if (m) out.settlement_sum = Number(m[1]);
      m = line.match(/^vaultrun_ws_connections\b[^\s]*\s+([0-9.e+]+)/);
      if (m) out.ws_connections = Number(m[1]);
      m = line.match(/^vaultrun_rounds_total\b[^\s]*\s+([0-9.e+]+)/);
      if (m) out.rounds_total = Number(m[1]);
      m = line.match(/^vaultrun_cashouts_total\b[^\s]*\s+([0-9.e+]+)/);
      if (m) out.cashouts_total = Number(m[1]);
    }
    // Server-side p99 from cumulative buckets.
    buckets.sort((a, b) => a.le - b.le);
    out.__buckets = buckets.length;
    (out as any).__bucketData = buckets;
  } catch (e: any) {
    out.__error = -1;
  }
  return out;
}

// Server-side percentile from Prometheus cumulative histogram buckets.
function serverPercentile(buckets: { le: number; v: number }[], total: number, p: number): number {
  if (!buckets.length || total === 0) return 0;
  const target = p * total;
  for (const b of buckets) {
    if (b.v >= target) return b.le;
  }
  return buckets[buckets.length - 1].le;
}

function fmtRow(name: string, h: number[]) {
  const n = histCount(h);
  if (n === 0) return `  ${name.padEnd(12)} ${"(no samples)".padStart(10)}`;
  const p = (q: number) => {
    const v = histPercentile(h, q);
    return v === Infinity ? ">5500" : String(v);
  };
  return (
    `  ${name.padEnd(12)} n=${String(n).padEnd(8)} ` +
    `p50=${p(0.5).padStart(5)}  p95=${p(0.95).padStart(5)}  p99=${p(0.99).padStart(6)}  max≈${p(1).padStart(6)}  (ms, bucket-upper)`
  );
}

async function runOrchestrator(cfg: Config) {
  console.log("=== Vault Run WS load harness (Phase 4.4) ===");
  console.log(
    `target=${cfg.BASE_URL} ${cfg.RAMP ? `RAMP→${cfg.RAMP_TO} over ${cfg.RAMP_SECONDS}s then hold ${cfg.DURATION_MS}ms` : `clients=${cfg.CLIENTS} duration=${cfg.DURATION_MS}ms`} ` +
      `workers=${cfg.WORKERS} betRate=${cfg.BET_RATE} cashoutAt=${cfg.CASHOUT_AT} betAmount=${cfg.BET_AMOUNT} auth=${cfg.AUTH_MODE}` +
      (cfg.AUTH_MODE === "operator" ? ` operator=${cfg.OPERATOR_CODE} ccy=${cfg.OPERATOR_CURRENCY}` : ""),
  );
  if (cfg.RAMP && !cfg.SCRAPE_METRICS) {
    console.log("  NOTE: RAMP mode without --scrape-metrics → the live series shows CLIENT-side cols only");
    console.log("        (launched/p99/tickgap/lag); add --scrape-metrics for the server ws_connections + settlement p99 columns (ground truth).");
  }

  // Confirm we're hitting a live API before generating load (don't trust a number
  // against a dead/ wrong server).
  try {
    const h = await fetch(`${cfg.BASE_URL}/health`).then((r) => r.json());
    console.log(`health: ${JSON.stringify(h)}`);
  } catch (e: any) {
    console.error(`health check FAILED against ${cfg.BASE_URL} — is the server up? (${e?.message})`);
    process.exit(2);
  }

  const before = cfg.SCRAPE_METRICS ? await scrapeMetrics(cfg) : null;
  if (before) console.log(`/metrics @start: ws_connections=${before.ws_connections ?? "?"} settlement_count=${before.settlement_count ?? "?"} rounds_total=${before.rounds_total ?? "?"}`);

  // Spread CLIENTS across WORKERS as evenly as possible.
  const base = Math.floor(cfg.CLIENTS / cfg.WORKERS);
  const rem = cfg.CLIENTS % cfg.WORKERS;
  const slices = Array.from({ length: cfg.WORKERS }, (_, i) => base + (i < rem ? 1 : 0));

  const reports: WorkerReport[] = [];
  const workers: Worker[] = [];
  let reported = 0;
  let midRunWs = -1; // ws_connections gauge sampled mid-run (sockets still live)
  let peakWs = 0; // highest ws_connections gauge seen across the whole run (RAMP peak)
  // Latest live snapshot per worker (RAMP mode) — aggregated by the sampler.
  const snaps = new Map<number, any>();
  // Captured live-series rows for the end-of-run knee summary.
  const series: { tMs: number; wsConn: number; launched: number; placeP99: number; serverP99: number; tickGap: number; lag: number; suspect: boolean; acceptRate: number }[] = [];
  const runStart = Date.now();
  // Total wall-clock before we signal stop: RAMP = ramp window + hold; FIXED = hold only.
  const totalRunMs = cfg.RAMP ? cfg.RAMP_SECONDS * 1000 + cfg.DURATION_MS : cfg.DURATION_MS;

  await new Promise<void>((resolveAll) => {
    slices.forEach((sliceSize, i) => {
      const w = new Worker(__filename, {
        workerData: { role: "worker", cfg, sliceSize, sliceIndex: i },
      });
      workers.push(w);
      w.on("message", (msg: any) => {
        if (msg?.type === "log") console.log(`  · ${msg.msg}`);
        else if (msg?.type === "snap") snaps.set(msg.threadId, msg);
        else if (msg?.type === "report") {
          reports.push(msg.report);
          reported++;
          if (reported === workers.length) resolveAll();
        }
      });
      w.on("error", (e) => console.error(`worker ${i} error:`, e?.message));
    });

    // ---- RAMP-mode LIVE degradation series ----
    // Every SAMPLE_EVERY_MS: scrape the server gauge + settlement p99 (ground truth) and
    // print it next to the aggregated client snapshots. Watch ws_connections climb and
    // p99 / tick-gap inflect — that knee is empirical per-node capacity. The orchestrator
    // is on its OWN thread (not a generator worker), so its scrape isn't CPU-starved.
    let sampleTimer: ReturnType<typeof setInterval> | null = null;
    if (cfg.RAMP) {
      console.log(
        "\n----- LIVE RAMP SERIES (watch ws_conn climb; p99/tickGap inflect = the knee) -----\n" +
          "  cols: wsConn=server gauge | launch=client launched | cliP99=client place_bet p99 |\n" +
          "        srvP99=server settlement p99 | tickGap=max SAME-ROUND inter-tick gap (mid-flight\n" +
          "        starvation; ~120ms healthy) | lag=worker loop lag | accept%=bet acks not timing out\n" +
          "   t(s)  wsConn  launch  cliP99  srvP99  tickGap  lag  accept%  note",
      );
      sampleTimer = setInterval(async () => {
        const tMs = Date.now() - runStart;
        // Aggregate the latest per-worker snapshots (client-side ground for this window).
        let launched = 0,
          connected = 0,
          betAccepted = 0,
          ackTimeouts = 0,
          placeP99 = 0,
          tickGap = 0,
          lag = 0,
          anySuspect = false;
        for (const s of snaps.values()) {
          launched += s.launched ?? 0;
          connected += s.connected ?? 0;
          betAccepted += s.betAccepted ?? 0;
          ackTimeouts += s.ackTimeouts ?? 0;
          placeP99 = Math.max(placeP99, s.placeP99 ?? 0);
          tickGap = Math.max(tickGap, s.windowTickGapMax ?? 0);
          lag = Math.max(lag, s.loopLagMax ?? 0);
          anySuspect = anySuspect || !!s.suspect;
        }
        let wsConn = -1,
          serverP99 = -1;
        if (cfg.SCRAPE_METRICS) {
          const m = await scrapeMetrics(cfg);
          if (!m.__error) {
            wsConn = m.ws_connections ?? 0;
            if (wsConn > peakWs) peakWs = wsConn;
            const bd = (m as any).__bucketData as { le: number; v: number }[] | undefined;
            serverP99 = bd ? serverPercentile(bd, m.settlement_count ?? 0, 0.99) : -1;
          }
        }
        const acceptRate = betAccepted + ackTimeouts > 0 ? betAccepted / (betAccepted + ackTimeouts) : 1;
        series.push({ tMs, wsConn: wsConn < 0 ? connected : wsConn, launched, placeP99, serverP99, tickGap, lag, suspect: anySuspect, acceptRate });
        const note = anySuspect ? "GEN-SUSPECT" : acceptRate < 0.98 ? "acks-dropping" : "";
        console.log(
          `  ${String(Math.round(tMs / 1000)).padStart(5)}  ${String(wsConn < 0 ? connected : wsConn).padStart(6)}  ${String(launched).padStart(6)}  ` +
            `${String(placeP99).padStart(6)}  ${String(serverP99 < 0 ? "-" : serverP99).padStart(6)}  ${String(tickGap).padStart(7)}  ${String(lag).padStart(4)}  ` +
            `${(acceptRate * 100).toFixed(1).padStart(6)}  ${note}`,
        );
      }, cfg.SAMPLE_EVERY_MS);
    }

    // Mid-run scrape (sockets still live) so we can report the ws_connections gauge
    // at peak — the post-run scrape sees 0 (all sockets closed during drain). In RAMP
    // mode peakWs (tracked in the sampler) is the better peak; keep this for FIXED-N.
    if (cfg.SCRAPE_METRICS && !cfg.RAMP) {
      setTimeout(
        () => {
          void scrapeMetrics(cfg).then((m) => {
            if (!m.__error) midRunWs = m.ws_connections ?? 0;
          });
        },
        Math.floor(cfg.DURATION_MS * 0.7),
      );
    }

    // Run window (ramp + hold, or just hold), THEN tell every worker to stop + report.
    setTimeout(() => {
      if (sampleTimer) clearInterval(sampleTimer);
      console.log(
        cfg.RAMP
          ? `ramp+hold ${Math.round(totalRunMs / 1000)}s elapsed — signalling stop…`
          : `steady-state ${cfg.DURATION_MS}ms elapsed — signalling stop…`,
      );
      for (const w of workers) w.postMessage({ type: "stop" });
    }, totalRunMs);
  });

  for (const w of workers) await w.terminate();

  // ---- aggregate ----
  const merged: Record<ActionName, number[]> = {
    place_bet: emptyHist(),
    cash_out: emptyHist(),
    bet_busted: emptyHist(),
  };
  const totals = {
    connected: 0,
    connectErrors: 0,
    authErrors: 0,
    betAccepted: 0,
    betRejected: 0,
    cashoutAccepted: 0,
    cashoutRejected: 0,
    busted: 0,
    ackTimeouts: 0,
    ticks: 0,
  };
  const rejectReasons: Record<string, number> = {};
  const tickGap = emptyHist();
  let maxTickGap = 0;
  let loopLagMax = 0;
  let anySuspect = false;
  for (const r of reports) {
    for (const a of ["place_bet", "cash_out", "bet_busted"] as ActionName[]) histMerge(merged[a], r.hist[a]);
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r.counts[k];
    for (const [reason, n] of Object.entries(r.rejectReasons)) rejectReasons[reason] = (rejectReasons[reason] ?? 0) + n;
    histMerge(tickGap, r.tickGapHist);
    maxTickGap = Math.max(maxTickGap, r.maxTickGapMs);
    loopLagMax = Math.max(loopLagMax, r.loopLagMaxMs);
    anySuspect = anySuspect || r.suspect;
  }

  const after = cfg.SCRAPE_METRICS ? await scrapeMetrics(cfg) : null;

  // ---- report ----
  console.log("\n----- CLIENT-OBSERVED LATENCY (ms, percentiles are bucket upper-bounds) -----");
  console.log("  (place_bet/cash_out = emit→ack roundtrip; the SETTLEMENT SLA is server-side — see /metrics below)");
  console.log(fmtRow("place_bet", merged.place_bet));
  console.log(fmtRow("cash_out", merged.cash_out));
  console.log(fmtRow("bet_busted", merged.bet_busted));
  console.log("  NOTE: bet_busted = crash→busted-push; INCLUDES the engine's deliberate ~3s crashed+settling");
  console.log("        pacing, so it is NOT settlement compute. Read server settlement_latency_ms for the SLA.");

  console.log("\n----- INTER-TICK GAP (failover/starvation hook) -----");
  console.log(fmtRow("tick_gap", tickGap));
  console.log(`  maxTickGap≈${maxTickGap}ms (target: ~120ms cadence; a long straddling gap = the failover window in 4.5)`);
  // A big client-side tick gap is AMBIGUOUS on a single host: it can be the SERVER
  // stalling its onTick loop, OR the GENERATOR threads being CPU-starved (so they
  // process incoming ticks late). Cross-check against the server's round cadence: if
  // the server completed the expected number of rounds (~one per ~12-15s), the gap is
  // generator-side, not a server tick stall. (In the 4.5 failover drill, on dedicated
  // generator hosts, a big gap IS the server failover window.)
  if (maxTickGap > cfg.TICK_GAP_WARN_MS) {
    const roundsDelta =
      cfg.SCRAPE_METRICS && after && before ? (after.rounds_total ?? 0) - (before.rounds_total ?? 0) : -1;
    if (roundsDelta >= 0) {
      const expectedRounds = Math.floor(cfg.DURATION_MS / 14000); // ~14s/round
      console.log(
        `  cross-check: server completed ${roundsDelta} round(s) during the run (expected ~${expectedRounds}). ` +
          (roundsDelta >= expectedRounds
            ? "Server cadence OK ⇒ the big gap is GENERATOR-side starvation (single host) — shard across machines for a clean 10k run."
            : "Server completed FEWER rounds than expected ⇒ a real server-side stall worth investigating."),
      );
    } else {
      console.log("  (pass --scrape-metrics to cross-check the gap against server round cadence.)");
    }
  }

  console.log("\n----- COUNTS -----");
  console.log(`  sockets: connected=${totals.connected}/${cfg.CLIENTS} connectErrors=${totals.connectErrors} authErrors=${totals.authErrors}`);
  console.log(`  bets:    accepted=${totals.betAccepted} rejected=${totals.betRejected} ackTimeouts=${totals.ackTimeouts}`);
  console.log(`  cashout: accepted=${totals.cashoutAccepted} rejected=${totals.cashoutRejected}`);
  console.log(`  busted:  ${totals.busted}   ticksReceived=${totals.ticks}`);
  if (Object.keys(rejectReasons).length) console.log(`  rejectReasons: ${JSON.stringify(rejectReasons)}`);

  console.log("\n----- GENERATOR HEALTH -----");
  console.log(`  worker loop-lag max≈${loopLagMax}ms (warn>${cfg.LAG_WARN_MS}ms)`);
  if (anySuspect) {
    console.log("  *** RUN SUSPECT: at least one generator worker's event loop was starved.");
    console.log("  *** The CLIENT numbers above may reflect generator lag, not the server. Add WORKERS / spread across machines and re-run.");
  } else {
    console.log("  generator loops healthy — client numbers reflect server behaviour (modulo network).");
  }

  if (cfg.SCRAPE_METRICS && after) {
    console.log("\n----- SERVER-SIDE /metrics (GROUND TRUTH for the settlement SLA) -----");
    if (after.__error) {
      console.log(`  /metrics scrape failed (status ${after.__error}). If locked (H5), pass METRICS_TOKEN=…`);
    } else {
      const bd = (after as any).__bucketData as { le: number; v: number }[] | undefined;
      const cStart = before?.settlement_count ?? 0;
      const cEnd = after.settlement_count ?? 0;
      // Cumulative-since-boot p99 (the histogram isn't windowed; this is all-time).
      const p99 = bd ? serverPercentile(bd, cEnd, 0.99) : 0;
      const p50 = bd ? serverPercentile(bd, cEnd, 0.5) : 0;
      const p95 = bd ? serverPercentile(bd, cEnd, 0.95) : 0;
      console.log(`  settlement_latency_ms (all-time): p50≈${p50} p95≈${p95} p99≈${p99}  (buckets: 10/25/50/100/200/500/1000)`);
      console.log(`  settlement observations: start=${cStart} end=${cEnd} (+${cEnd - cStart} during run)`);
      console.log(
        `  ws_connections gauge: ${cfg.RAMP ? `peak=${peakWs} (ramp peak)` : `mid-run=${midRunWs >= 0 ? midRunWs : "?"} (peak, sockets live)`} end=${after.ws_connections ?? "?"} ` +
          `(vs client connected=${totals.connected}; end is ~0 after drain — expected). ` +
          `This gauge is the HONEST concurrency number — sum it across generator hosts.`,
      );
      console.log(`  rounds_total: start=${before?.rounds_total ?? "?"} end=${after.rounds_total ?? "?"}  cashouts_total end=${after.cashouts_total ?? "?"}`);
      if (cfg.AUTH_MODE === "operator") {
        console.log(`  NOTE: clients authed as OPERATOR players → settlement ran the SeamlessOperatorWallet HTTP path (the settlement-SLA WORST CASE). This server-side p99 IS the operator-mode number — assert it against 200ms.`);
      } else {
        console.log(`  NOTE: clients authed as GUESTS → INTERNAL play-money ledger (in-process). The settlement-SLA worst case is OPERATOR mode — re-run with AUTH_MODE=operator (see load/README.md).`);
      }
    }
  }

  // ---- RAMP knee summary: the empirical per-node capacity call ----
  if (cfg.RAMP && series.length) {
    console.log("\n----- RAMP DEGRADATION SUMMARY (empirical per-node capacity) -----");
    // "Healthy" = server settlement p99 < 200ms (or unknown), inter-tick gap under the
    // warn threshold, generator NOT suspect, and accept-rate ≥ 98% (acks not dropping).
    // The LAST healthy sample's ws_connections is the conservative sustained ceiling;
    // the FIRST unhealthy sample marks the knee.
    const healthy = (s: (typeof series)[number]) =>
      (s.serverP99 < 0 || s.serverP99 <= 200) &&
      s.tickGap <= cfg.TICK_GAP_WARN_MS &&
      !s.suspect &&
      s.acceptRate >= 0.98;
    let lastHealthy: (typeof series)[number] | null = null;
    let firstBad: (typeof series)[number] | null = null;
    for (const s of series) {
      if (healthy(s)) lastHealthy = s;
      else if (!firstBad) firstBad = s;
    }
    console.log(`  peak ws_connections reached : ${peakWs}${cfg.SCRAPE_METRICS ? "" : " (client-side; add --scrape-metrics for the server gauge)"}`);
    if (lastHealthy) {
      console.log(`  last HEALTHY sample          : ws_conn=${lastHealthy.wsConn} @ t+${Math.round(lastHealthy.tMs / 1000)}s (cliP99=${lastHealthy.placeP99} srvP99=${lastHealthy.serverP99 < 0 ? "?" : lastHealthy.serverP99} tickGap=${lastHealthy.tickGap} accept=${(lastHealthy.acceptRate * 100).toFixed(1)}%)`);
    } else {
      console.log("  last HEALTHY sample          : NONE — degraded from the very first sample (start lower / add WORKERS / more generator hosts)");
    }
    if (firstBad) {
      const reasons = [
        firstBad.serverP99 > 200 ? `srvP99=${firstBad.serverP99}>200` : "",
        firstBad.tickGap > cfg.TICK_GAP_WARN_MS ? `tickGap=${firstBad.tickGap}>${cfg.TICK_GAP_WARN_MS}` : "",
        firstBad.suspect ? "generator-suspect" : "",
        firstBad.acceptRate < 0.98 ? `accept=${(firstBad.acceptRate * 100).toFixed(1)}%<98%` : "",
      ].filter(Boolean).join(", ");
      console.log(`  KNEE (first degraded sample) : ws_conn=${firstBad.wsConn} @ t+${Math.round(firstBad.tMs / 1000)}s → ${reasons}`);
      if (firstBad.suspect) {
        console.log("  *** the knee is GENERATOR-side (suspect) — this run measured the generator's ceiling, NOT the server's.");
        console.log("  *** add WORKERS and/or more generator HOSTS and re-run; the true server knee is higher.");
      } else {
        console.log("  *** the knee is SERVER-side (generator healthy) — THIS is the per-node capacity signal. Size the cluster from the last-healthy ws_conn.");
      }
    } else {
      console.log("  KNEE                         : not reached — server stayed healthy to the ceiling. Raise RAMP_TO and/or add generator hosts to find it.");
    }
    console.log("  (capacity/node ⇒ cluster sizing: nodes ≳ ceil(10000 / last-healthy-ws_conn-per-node), then add headroom + a node for failover.)");
  }

  console.log("\n=== done ===");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Entrypoint dispatch.
// ---------------------------------------------------------------------------
if (isMainThread) {
  runOrchestrator(buildConfig());
} else {
  const { cfg, sliceSize, sliceIndex } = workerData as { cfg: Config; sliceSize: number; sliceIndex: number };
  runWorker(cfg, sliceSize, sliceIndex).catch((e) => {
    parentPort?.postMessage({ type: "log", msg: `worker ${threadId} crashed: ${e?.message}` });
    parentPort?.postMessage({
      type: "report",
      report: {
        threadId,
        hist: { place_bet: emptyHist(), cash_out: emptyHist(), bet_busted: emptyHist() },
        counts: { connected: 0, connectErrors: 0, authErrors: 0, betAccepted: 0, betRejected: 0, cashoutAccepted: 0, cashoutRejected: 0, busted: 0, ackTimeouts: 0, ticks: 0 },
        rejectReasons: {},
        tickGapHist: emptyHist(),
        maxTickGapMs: 0,
        loopLagMaxMs: 0,
        suspect: true,
      } as WorkerReport,
    });
  });
}
