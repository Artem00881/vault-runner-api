/**
 * Phase 4.5c.3 — 2-node leader-SIGKILL FAILOVER DRILL (the headline c.3 piece).
 *
 * WHAT IT PROVES: when the engine LEADER is hard-killed mid-`running`, a survivor
 * (a) re-acquires leadership and RESUMES the in-flight round (4.5c.2 seamless
 * failover-resume) within the <5s SLA, and (b) does NOT close+refund the bets that
 * should have ridden the round through — the SAME roundId crashes at its committed
 * point and settles (cashed_out / busted), no `restart_refund` / `cancelled`.
 *
 * HOW (self-contained orchestrator):
 *  1. Spawn TWO `bun run src/main.ts` processes on PORT_A / PORT_B against the SAME
 *     pg + redis. BOTH are election-eligible (GAME_AUTOSTART left default — a node
 *     with GAME_AUTOSTART=false NEVER participates, so the survivor could not take
 *     over; see election.service.ts). One wins the pg advisory lock + runs the
 *     engine; the other is a pure follower that still serves WS (Redis adapter fans
 *     the leader's broadcasts to BOTH nodes' clients).
 *  2. Attach a small fleet of Socket.IO clients SPLIT across both nodes; each
 *     timestamps every `multiplier_update` (the inter-tick-gap hook) and a subset
 *     place a bet WITHOUT auto-cashout (ride-through) so we have bets that must
 *     survive the failover and bust/settle on the resumed round.
 *  3. Wait until the engine is `running` with our ride-through bets active, then
 *     SIGKILL the LEADER process (identified via engine_leadership.node_id ↔ each
 *     child's logged nodeId).
 *  4. Measure the FAILOVER GAP = (first tick after a survivor resumes) − (last tick
 *     before the kill), across the surviving clients (the kill drops the leader's own
 *     clients; the follower's clients keep their socket and see the resumed ticks).
 *  5. Assert the round RESUMED: the SAME roundId reaches a terminal crash+settle and
 *     its ride-through bets ended cashed_out|busted (NOT cancelled) with NO
 *     `bet:{id}:restart_refund` ledger row. Report gap vs the 5s SLA.
 *
 * Local-feasible: two bun processes + a handful of clients on the dockerized pg+redis.
 * Keep CLIENTS modest (default 20) — this measures FAILOVER TIMING + RESUME CORRECTNESS,
 * not throughput (that's ws-load.ts). The full multi-host 10k drill is staging-gated.
 *
 * ENV:
 *   PORT_A (3021) / PORT_B (3022)   the two node ports
 *   CLIENTS        (20)             total WS clients split across both nodes
 *   BET_RATE       (0.6)            fraction that place a ride-through bet
 *   BET_AMOUNT     (50)             stake (minor units)
 *   FAILOVER_SLA_MS(5000)           the SLA to assert the gap against
 *   KILL_AT_MULT   (1.15)          SIGKILL once the running multiplier crosses this
 *   MAX_WAIT_MS    (45000)          give up if no `running` round appears in time
 *   DATABASE_URL / REDIS_URL / JWT_SECRET / GAME_CURRENCY  (passed to the children)
 *
 * RUN:
 *   DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
 *     REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
 *     bun load/failover-drill.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const CFG = {
  PORT_A: Number(process.env.PORT_A ?? 3021),
  PORT_B: Number(process.env.PORT_B ?? 3022),
  CLIENTS: Number(process.env.CLIENTS ?? 20),
  BET_RATE: Number(process.env.BET_RATE ?? 0.6),
  BET_AMOUNT: Number(process.env.BET_AMOUNT ?? 50),
  FAILOVER_SLA_MS: Number(process.env.FAILOVER_SLA_MS ?? 5000),
  KILL_AT_MULT: Number(process.env.KILL_AT_MULT ?? 1.15),
  MAX_WAIT_MS: Number(process.env.MAX_WAIT_MS ?? 45000),
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://vault:vault@localhost:5432/vaultrun?schema=public",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

interface Node {
  port: number;
  proc: ChildProcess;
  nodeId: string | null; // parsed from "[node=...]" in its election log
  acquiredLeader: boolean; // saw "acquired leadership" in its log (ever)
  killed: boolean;
  logTail: string[];
}

// Boot one node, capture stdout/stderr, parse its election nodeId + leadership events.
function bootNode(port: number): Node {
  const node: Node = { port, proc: null as any, nodeId: null, acquiredLeader: false, killed: false, logTail: [] };
  const proc = spawn("bun", ["run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: CFG.DATABASE_URL,
      REDIS_URL: CFG.REDIS_URL,
      JWT_SECRET: process.env.JWT_SECRET ?? "x",
      GAME_CURRENCY: process.env.GAME_CURRENCY ?? "DEMO",
      // BOTH nodes must be election-eligible so the survivor can take over.
      // (GAME_AUTOSTART=false would make a node a permanent follower — never leader.)
    },
  });
  node.proc = proc;
  const onData = (buf: Buffer) => {
    const text = buf.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      node.logTail.push(line);
      if (node.logTail.length > 60) node.logTail.shift();
      // "[node=node-0b6d0947]" — capture this process's stable election identity.
      const m = line.match(/\[node=([^\]]+)\]/);
      if (m && !node.nodeId) node.nodeId = m[1];
      if (/acquired leadership/.test(line)) node.acquiredLeader = true;
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code, sig) => {
    if (!node.killed) console.log(`  [node :${port}] exited unexpectedly code=${code} sig=${sig}`);
  });
  return node;
}

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

// Which node currently holds leadership, per the AUTHORITATIVE fence row
// (engine_leadership.node_id). HaModule writes node_id = `${HOSTNAME}-${process.pid}`
// (hostNodeId() in ha.module.ts → PgAdvisoryLock), so we map the fence row's node_id to
// a child by its PROCESS PID — robust and free of any log-parse race. (The election LOG
// line prints a different uuid-based id; we deliberately key on the pid the fence uses.)
async function currentLeaderNode(prisma: PrismaClient, nodes: Node[]): Promise<{ node: Node | null; nodeId: string | null; fence: bigint }> {
  const rows = await prisma.$queryRaw<{ node_id: string | null; fence: bigint }[]>`
    SELECT node_id, fence FROM engine_leadership WHERE id = true`;
  const leaderId = rows[0]?.node_id ?? null;
  const fence = BigInt(rows[0]?.fence ?? 0n);
  // node_id ends with `-<pid>`; match the trailing pid to a live child.
  const node =
    nodes.find((n) => n.proc.pid != null && leaderId != null && leaderId.endsWith(`-${n.proc.pid}`)) ?? null;
  return { node, nodeId: leaderId, fence };
}

// ---------------------------------------------------------------------------
// Embedded Socket.IO client fleet (focused: timestamp ticks + ride-through bets).
// ---------------------------------------------------------------------------
interface ClientState {
  port: number;
  socket: any;
  userId: string | null;
  lastTickAt: number;
  betRoundId: string | null; // round we placed a ride-through bet on
  betAccepted: boolean;
  betPanel: string;
  willBet: boolean;
  // tick timeline as [epochMs, multiplier] so we can find the gap around the kill.
  ticks: { t: number; m: number; roundId: string }[];
}

async function startClient(io: any, port: number, willBet: boolean): Promise<ClientState> {
  // Guest auth (internal wallet — failover correctness is wallet-agnostic; the
  // operator-mode settlement run is a SEPARATE harness, ws-load.ts AUTH_MODE=operator).
  const token = await (async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`http://localhost:${port}/api/auth/guest`, { method: "POST" });
        if (r.ok) return ((await r.json()) as any).token as string;
      } catch {
        /* retry */
      }
      await sleep(200);
    }
    return null;
  })();
  const cs: ClientState = {
    port,
    socket: null,
    userId: null,
    lastTickAt: 0,
    betRoundId: null,
    betAccepted: false,
    betPanel: "A",
    willBet,
    ticks: [],
  };
  const socket = io(`http://localhost:${port}`, {
    transports: ["websocket"],
    reconnection: true, // survive a follower→leader flip; the kill drops the leader's clients
    reconnectionDelay: 250,
    auth: token ? { token } : {},
    timeout: 5000,
  });
  cs.socket = socket;

  socket.on("round_state", (s: any) => {
    if (!s) return;
    // Place a ride-through bet (NO auto-cashout) so this bet MUST survive the failover
    // and bust/settle on the resumed round — the resume-vs-refund assertion's subject.
    if (s.phase === "betting" && cs.willBet && !cs.betAccepted && cs.betRoundId === null) {
      cs.betRoundId = s.roundId;
      socket.timeout(5000).emit("place_bet", { panel: cs.betPanel, amount: CFG.BET_AMOUNT }, (err: unknown, r: any) => {
        if (!err && r?.ok) cs.betAccepted = true;
        else cs.betRoundId = null; // failed → allow a retry next betting window
      });
    }
  });
  socket.on("multiplier_update", (m: any) => {
    const t = now();
    cs.lastTickAt = t;
    cs.ticks.push({ t, m: m.multiplier, roundId: m.roundId });
  });
  return cs;
}

async function main() {
  console.log("=== Vault Run 2-node FAILOVER SIGKILL drill (Phase 4.5c.3) ===");
  console.log(
    `ports=${CFG.PORT_A},${CFG.PORT_B} clients=${CFG.CLIENTS} betRate=${CFG.BET_RATE} ` +
      `killAtMult=${CFG.KILL_AT_MULT} SLA=${CFG.FAILOVER_SLA_MS}ms`,
  );

  const prisma = new PrismaClient({ datasources: { db: { url: CFG.DATABASE_URL } } });
  const { io } = (await import("socket.io-client")) as typeof import("socket.io-client");

  // Pre-flight: a clean-ish DB. Open rounds from a prior aborted run confuse the
  // resume assertion — warn (the new leader will resume/close them on boot anyway).
  const preOpen = await prisma.round.count({ where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } } });
  if (preOpen > 0) console.log(`  ⚠ ${preOpen} open round(s) already in the DB — boot recovery will handle them; results read the NEW round.`);

  // 1) Boot both nodes (staggered so their first acquire-polls don't collide).
  console.log("booting node A…");
  const a = bootNode(CFG.PORT_A);
  await sleep(800);
  console.log("booting node B…");
  const b = bootNode(CFG.PORT_B);
  const nodes = [a, b];

  const okA = await waitHealthy(CFG.PORT_A, 30000);
  const okB = await waitHealthy(CFG.PORT_B, 30000);
  if (!okA || !okB) {
    console.error(`node health FAILED (A=${okA} B=${okB}). Tails:`);
    for (const n of nodes) console.error(`  :${n.port}\n    ${n.logTail.slice(-8).join("\n    ")}`);
    await shutdown(nodes, prisma, 2);
    return;
  }
  // Settle a beat so leadership + nodeIds are parsed from the logs.
  await sleep(1500);
  const lead0 = await currentLeaderNode(prisma, nodes);
  console.log(
    `both healthy. leader fence-row node_id=${lead0.nodeId ?? "?"} → port ${lead0.node?.port ?? "?"} (pid ${lead0.node?.proc.pid ?? "?"}) fence=${lead0.fence} ` +
      `| A=:${a.port}/pid${a.proc.pid} B=:${b.port}/pid${b.proc.pid}`,
  );
  if (!lead0.node) {
    console.error("could not map the leader fence row to a child process nodeId — aborting.");
    await shutdown(nodes, prisma, 2);
    return;
  }

  // 2) Attach the client fleet, split across both ports.
  console.log(`attaching ${CFG.CLIENTS} clients (split across both nodes)…`);
  const clients: ClientState[] = [];
  for (let i = 0; i < CFG.CLIENTS; i++) {
    const port = i % 2 === 0 ? CFG.PORT_A : CFG.PORT_B;
    const willBet = Math.random() < CFG.BET_RATE;
    clients.push(await startClient(io, port, willBet));
    await sleep(30); // gentle ramp
  }
  // Clients on the FOLLOWER node keep their socket through the leader's death (the
  // Redis adapter still delivers the resumed leader's ticks to them) → they carry the
  // clean failover-gap timeline. Track which port is the follower.
  const followerPort = lead0.node.port === CFG.PORT_A ? CFG.PORT_B : CFG.PORT_A;

  // 3) Wait for a `running` round with our ride-through bets active, then SIGKILL the leader.
  console.log(`waiting for a 'running' round (kill the leader once multiplier ≥ ${CFG.KILL_AT_MULT})…`);
  const waitDeadline = now() + CFG.MAX_WAIT_MS;
  let killInfo: { roundId: string; killAt: number; lastTickBeforeKill: number; leaderPort: number } | null = null;
  while (now() < waitDeadline && !killInfo) {
    await sleep(60);
    // Find the live running round + its current multiplier from the latest ticks.
    const recent = clients
      .flatMap((c) => c.ticks.slice(-1))
      .filter((t) => t && now() - t.t < 1000)
      .sort((x, y) => y.m - x.m)[0];
    if (!recent) continue;
    if (recent.m < CFG.KILL_AT_MULT) continue;

    // Confirm there are ACTIVE ride-through bets on THIS round (the resume subjects).
    const activeBets = await prisma.bet.count({ where: { roundId: recent.roundId, status: "active" } });
    if (activeBets === 0) continue; // wait for a round that actually has live bets to ride through

    // Re-read the leader RIGHT NOW (in case it flipped) and SIGKILL it.
    const lead = await currentLeaderNode(prisma, nodes);
    if (!lead.node) continue;
    const lastTickBeforeKill = Math.max(...clients.map((c) => c.lastTickAt).filter((t) => t > 0), 0);
    lead.node.killed = true;
    console.log(
      `\n>>> SIGKILL leader node :${lead.node.port} (pid ${lead.node.proc.pid}) at multiplier≈${recent.m} ` +
        `round=${recent.roundId.slice(0, 8)} activeBets=${activeBets} fence=${lead.fence}`,
    );
    lead.node.proc.kill("SIGKILL");
    killInfo = { roundId: recent.roundId, killAt: now(), lastTickBeforeKill, leaderPort: lead.node.port };
  }

  if (!killInfo) {
    console.error(`no 'running' round with active ride-through bets within ${CFG.MAX_WAIT_MS}ms — aborting.`);
    await shutdown(nodes, prisma, 2);
    return;
  }

  // 4) Measure the failover gap: first tick on a SURVIVING (follower-node) client whose
  // timestamp is AFTER the kill. The follower's clients keep their socket; the resumed
  // leader's ticks reach them via the Redis adapter. Watch the survivor reacquire too.
  console.log(`measuring failover gap (waiting for ticks to resume on the survivor :${followerPort})…`);
  const survivors = clients.filter((c) => c.port === followerPort);
  const gapDeadline = killInfo.killAt + Math.max(CFG.FAILOVER_SLA_MS * 3, 20000);
  let firstTickAfter = 0;
  let resumedRoundId: string | null = null;
  let survivorAcquiredAt = 0;
  const followerNode = nodes.find((n) => n.port === followerPort)!;
  while (now() < gapDeadline && firstTickAfter === 0) {
    await sleep(40);
    // Note when the survivor logs the acquire (leadership timing, independent of ticks).
    if (survivorAcquiredAt === 0 && followerNode.logTail.some((l) => /acquired leadership/.test(l))) {
      survivorAcquiredAt = now();
    }
    for (const c of survivors) {
      const post = c.ticks.find((t) => t.t > killInfo!.killAt);
      if (post) {
        firstTickAfter = post.t;
        resumedRoundId = post.roundId;
        break;
      }
    }
  }

  const tickGapMs = firstTickAfter > 0 ? firstTickAfter - killInfo.lastTickBeforeKill : -1;
  const acquireGapMs = survivorAcquiredAt > 0 ? survivorAcquiredAt - killInfo.killAt : -1;

  // 5) Wait for the round to reach a terminal state, then assert RESUME-not-refund.
  console.log("waiting for the resumed round to settle, then checking resume-vs-refund…");
  let finalStatus = "unknown";
  const settleDeadline = now() + 20000;
  while (now() < settleDeadline) {
    const r = await prisma.round.findUnique({ where: { id: killInfo.roundId }, select: { status: true } });
    finalStatus = r?.status ?? "missing";
    if (finalStatus === "completed") break;
    await sleep(250);
  }

  // The ride-through bets on the killed round: did they SETTLE (cashed_out|busted) on the
  // resumed round, or were they REFUNDED (cancelled + a restart_refund ledger row)?
  const betRows = await prisma.bet.findMany({
    where: { roundId: killInfo.roundId },
    select: { id: true, status: true },
  });
  const byStatus: Record<string, number> = {};
  for (const br of betRows) byStatus[br.status] = (byStatus[br.status] ?? 0) + 1;
  const refundKeys = await prisma.ledgerTransaction.count({
    where: {
      type: "refund",
      idempotencyKey: { in: betRows.map((br) => `bet:${br.id}:restart_refund`) },
    },
  });
  const settledRideThrough = (byStatus["cashed_out"] ?? 0) + (byStatus["busted"] ?? 0);
  const cancelled = byStatus["cancelled"] ?? 0;
  const resumedSameRound = resumedRoundId === killInfo.roundId || finalStatus === "completed";
  const wasResumed = finalStatus === "completed" && refundKeys === 0 && cancelled === 0 && settledRideThrough > 0;

  // ---- report ----
  console.log("\n================= FAILOVER DRILL RESULT =================");
  console.log(`killed leader            : node :${killInfo.leaderPort}`);
  console.log(`survivor (measured on)   : node :${followerPort}`);
  console.log(`in-flight round          : ${killInfo.roundId}`);
  console.log(`final round status       : ${finalStatus}`);
  console.log(`resumed-round tick id    : ${resumedRoundId ?? "(none seen)"} ${resumedSameRound ? "(SAME round → resumed)" : "(DIFFERENT/none)"}`);
  console.log("");
  console.log("---- FAILOVER TIMING (vs SLA " + CFG.FAILOVER_SLA_MS + "ms) ----");
  console.log(`last tick before kill    : t=${killInfo.lastTickBeforeKill}`);
  console.log(`first tick after resume  : ${firstTickAfter > 0 ? `t=${firstTickAfter}` : "NONE (ticks did not resume in window)"}`);
  console.log(`>> FAILOVER GAP (tick→tick): ${tickGapMs >= 0 ? tickGapMs + "ms" : "n/a"}  ${tickGapMs >= 0 ? (tickGapMs < CFG.FAILOVER_SLA_MS ? "✅ < SLA" : "❌ ≥ SLA") : ""}`);
  console.log(`   survivor acquire gap   : ${acquireGapMs >= 0 ? acquireGapMs + "ms" : "n/a"} (kill → 'acquired leadership' log on survivor)`);
  console.log("");
  console.log("---- RESUME-vs-REFUND (ride-through bets on the killed round) ----");
  console.log(`bet statuses             : ${JSON.stringify(byStatus)}`);
  console.log(`settled (cashed|busted)  : ${settledRideThrough}`);
  console.log(`cancelled (refund path)  : ${cancelled}`);
  console.log(`restart_refund ledger rows: ${refundKeys}  ${refundKeys === 0 ? "✅ none (not close+refunded)" : "❌ refunds present (close+refund happened)"}`);
  console.log("");
  const timingOk = tickGapMs >= 0 && tickGapMs < CFG.FAILOVER_SLA_MS;
  const resumeOk = wasResumed;
  console.log(`VERDICT: failover timing ${timingOk ? "MET" : "NOT MET"} (gap ${tickGapMs}ms vs ${CFG.FAILOVER_SLA_MS}ms SLA)`);
  console.log(`         seamless resume ${resumeOk ? "CONFIRMED" : "NOT CONFIRMED"} (round resumed + bets settled, no refund)`);
  console.log("========================================================\n");

  await shutdown(nodes, prisma, timingOk && resumeOk ? 0 : 1);
}

async function shutdown(nodes: Node[], prisma: PrismaClient, code: number) {
  for (const n of nodes) {
    if (!n.proc.killed && n.proc.exitCode === null) {
      n.killed = true;
      try {
        n.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  await prisma.$disconnect().catch(() => undefined);
  // Give the OS a moment to reap children before exit.
  await sleep(300);
  process.exit(code);
}

main().catch(async (e) => {
  console.error("failover-drill crashed:", e?.message ?? e);
  process.exit(2);
});
