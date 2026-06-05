/**
 * Phase 4.5c.3 — shared multi-node harness helpers (used by failover-drill.ts +
 * recon-soak.ts). Boots `bun run src/main.ts` child nodes against the SAME pg+redis,
 * maps the authoritative leader (engine_leadership.node_id ↔ child pid), and a tiny
 * Socket.IO client that timestamps ticks + places ride-through bets. Kept here so the
 * drill and the soak can't drift in how they boot a node / find the leader / kill it.
 *
 * NOT part of src/** (dev-only tooling, outside the tsc CI typecheck) — run via bun.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { PrismaClient } from "@prisma/client";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();

export interface ChildEnvOverrides {
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  JWT_SECRET?: string;
  GAME_CURRENCY?: string;
  WALLET_PROVIDER_TYPE?: string;
  [k: string]: string | number | undefined;
}

export interface Node {
  port: number;
  proc: ChildProcess;
  killed: boolean; // we intentionally killed it (don't warn on its exit)
  acquiredLeaderEver: boolean; // saw "acquired leadership" in its log (failover signal)
  logTail: string[];
}

/** Boot one API node, capturing stdout/stderr and parsing leadership-acquire events. */
export function bootNode(env: ChildEnvOverrides, label = `:${env.PORT}`): Node {
  const node: Node = { port: env.PORT, proc: null as any, killed: false, acquiredLeaderEver: false, logTail: [] };
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = String(v);
  const proc = spawn("bun", ["run", "src/main.ts"], { cwd: process.cwd(), env: childEnv });
  node.proc = proc;
  const onData = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      node.logTail.push(line);
      if (node.logTail.length > 80) node.logTail.shift();
      if (/acquired leadership/.test(line)) node.acquiredLeaderEver = true;
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code, sig) => {
    if (!node.killed) console.log(`  [node ${label}] exited UNEXPECTEDLY code=${code} sig=${sig}`);
  });
  return node;
}

/** Poll /health until the node answers ok, or timeout. */
export async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

/**
 * The current leader per the AUTHORITATIVE fence row. HaModule writes
 * node_id = `${HOSTNAME}-${pid}` (ha.module.ts hostNodeId() → PgAdvisoryLock), so we map
 * the fence row to a live child by PROCESS PID — robust, no log-parse race.
 */
export async function currentLeader(
  prisma: PrismaClient,
  nodes: Node[],
): Promise<{ node: Node | null; nodeId: string | null; fence: bigint }> {
  const rows = await prisma.$queryRaw<{ node_id: string | null; fence: bigint }[]>`
    SELECT node_id, fence FROM engine_leadership WHERE id = true`;
  const nodeId = rows[0]?.node_id ?? null;
  const fence = BigInt(rows[0]?.fence ?? 0n);
  const node = nodes.find((n) => n.proc.pid != null && nodeId != null && nodeId.endsWith(`-${n.proc.pid}`)) ?? null;
  return { node, nodeId, fence };
}

/** SIGKILL every still-running child (cleanup / shutdown). */
export async function killAll(nodes: Node[]): Promise<void> {
  for (const n of nodes) {
    if (n.proc.exitCode === null && !n.proc.killed) {
      n.killed = true;
      try {
        n.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  await sleep(300); // let the OS reap
}

// ---------------------------------------------------------------------------
// Minimal Socket.IO client (timestamp ticks + optional ride-through bet).
// ---------------------------------------------------------------------------
export interface HarnessClient {
  port: number;
  socket: any;
  lastTickAt: number;
  betRoundId: string | null;
  betAccepted: boolean;
  willBet: boolean;
  ticks: { t: number; m: number; roundId: string }[];
  bets: number;
  cashouts: number;
  busts: number;
}

/** Auth as a guest and connect a tracking client. `io` is the socket.io-client factory. */
export async function startGuestClient(
  io: any,
  port: number,
  opts: { willBet: boolean; betAmount: number; cashoutAt?: number },
): Promise<HarnessClient> {
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
  const cs: HarnessClient = {
    port,
    socket: null,
    lastTickAt: 0,
    betRoundId: null,
    betAccepted: false,
    willBet: opts.willBet,
    ticks: [],
    bets: 0,
    cashouts: 0,
    busts: 0,
  };
  const socket = io(`http://localhost:${port}`, {
    transports: ["websocket"],
    reconnection: true, // survive the leader's death (the follower keeps serving this socket)
    reconnectionDelay: 250,
    auth: token ? { token } : {},
    timeout: 5000,
  });
  cs.socket = socket;
  socket.on("round_state", (s: any) => {
    if (!s || !cs.willBet) return;
    if (s.phase === "betting" && cs.betRoundId !== s.roundId) {
      // New betting window — place a fresh bet each round so the soak keeps churning money.
      cs.betRoundId = s.roundId;
      const payload: any = { panel: "A", amount: opts.betAmount };
      if (opts.cashoutAt && opts.cashoutAt > 1) payload.autoCashout = opts.cashoutAt;
      socket.timeout(5000).emit("place_bet", payload, (err: unknown, r: any) => {
        if (!err && r?.ok) {
          cs.betAccepted = true;
          cs.bets++;
        }
      });
    }
  });
  socket.on("multiplier_update", (m: any) => {
    cs.lastTickAt = now();
    cs.ticks.push({ t: cs.lastTickAt, m: m.multiplier, roundId: m.roundId });
    if (cs.ticks.length > 5000) cs.ticks.shift();
  });
  socket.on("cashout_accepted", () => cs.cashouts++);
  socket.on("bet_busted", () => cs.busts++);
  return cs;
}
