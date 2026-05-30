import { io, type Socket } from "socket.io-client";

const BASE = "http://localhost:3001";
const CLIENTS = Number(process.env.CLIENTS ?? 40);
const DURATION = Number(process.env.DURATION ?? 25000);

const stats = { connected: 0, accepted: 0, rejected: 0, cashed: 0, busted: 0, errors: 0 };

async function makeClient(i: number): Promise<Socket | null> {
  try {
    const guest = await fetch(`${BASE}/api/auth/guest`, { method: "POST" }).then((r) => r.json());
    const socket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token: guest.token } });
    let betRound: string | null = null;

    socket.on("connect", () => stats.connected++);
    socket.on("connect_error", () => stats.errors++);
    socket.on("round_state", (s: any) => {
      if (s?.phase === "betting" && s.roundId !== betRound) {
        betRound = s.roundId;
        socket.emit("place_bet", { panel: "A", amount: 50, autoCashout: 1.5 });
      }
    });
    socket.on("bet_accepted", () => stats.accepted++);
    socket.on("bet_rejected", () => stats.rejected++);
    socket.on("cashout_accepted", () => stats.cashed++);
    socket.on("bet_busted", () => stats.busted++);
    return socket;
  } catch {
    stats.errors++;
    return null;
  }
}

async function main() {
  console.log(`spawning ${CLIENTS} clients for ${DURATION / 1000}s…`);
  const t0 = Date.now();
  const sockets = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => makeClient(i)));
  console.log(`auth+connect of ${CLIENTS} clients took ${Date.now() - t0}ms`);

  await new Promise((r) => setTimeout(r, DURATION));

  // server still responsive?
  const t1 = Date.now();
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  const healthMs = Date.now() - t1;

  console.log("stats:", JSON.stringify(stats));
  console.log(`health after load: ${health ? "ok" : "FAIL"} (${healthMs}ms)`);
  const ok = stats.connected >= CLIENTS * 0.95 && stats.accepted > 0 && health && stats.errors === 0;
  console.log(ok ? "LOAD TEST: PASS" : "LOAD TEST: FAIL");
  sockets.forEach((s) => s?.close());
  process.exit(ok ? 0 : 1);
}

main();
