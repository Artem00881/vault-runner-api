/**
 * Sandbox end-to-end verify (Phase 6 #3): drive a REAL operator session through the
 * seamless-wallet path against the stub. Launch -> read balance -> WS place_bet ->
 * settle (auto-cashout or bust) -> print the betId so the caller can then void it.
 *
 * Run INSIDE the api container (socket.io-client + the session reach localhost:3001):
 *   docker compose ... exec -T api sh -c \
 *     'SMOKE_BASE=http://localhost:3001 bun scripts/sandbox-verify.ts <LAUNCH_TOKEN>'
 *
 * Prints machine-greppable lines: RESULT_BETID=<id>, RESULT_OUTCOME=<cashed_out|busted>.
 */
import { io } from "socket.io-client";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const launchToken = process.argv[2];

async function main() {
  if (!launchToken) {
    console.error("usage: bun scripts/sandbox-verify.ts <LAUNCH_TOKEN>");
    process.exit(1);
  }

  // 1) launch -> session token
  const launchRes = await fetch(`${BASE}/api/operator/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: launchToken }),
  });
  const launch = (await launchRes.json()) as any;
  console.log("LAUNCH:", JSON.stringify(launch));
  const session = launch.token as string;
  if (!session) {
    console.error("no session token in launch response");
    process.exit(1);
  }

  // 2) balance -> proves the seamless /balance call hit the stub end-to-end
  const bal0 = await fetch(`${BASE}/api/wallet/balance`, { headers: { authorization: `Bearer ${session}` } }).then((r) => r.json());
  console.log("BALANCE_AFTER_LAUNCH:", JSON.stringify(bal0));

  // 3) WS place a bet, let it auto-cash at 1.2x (or bust), capture the betId
  const socket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token: session } });
  let betId: string | null = null;
  let placed = false;
  let done = false;

  const finish = (outcome: string) => {
    if (done) return;
    done = true;
    console.log("RESULT_BETID=" + (betId ?? ""));
    console.log("RESULT_OUTCOME=" + outcome);
    setTimeout(() => process.exit(betId ? 0 : 1), 1200);
  };

  socket.on("connect", () => console.log("ws connected"));
  socket.on("round_state", (s: any) => {
    if (s?.phase === "betting" && !placed && !done) {
      placed = true;
      socket.emit("place_bet", { panel: "A", amount: 100, autoCashout: 1.2 }, (ack: any) =>
        console.log("PLACE_ACK:", JSON.stringify(ack)),
      );
    }
  });
  socket.on("bet_accepted", (b: any) => {
    betId = b.betId;
    console.log("BET_ACCEPTED:", JSON.stringify(b));
  });
  socket.on("bet_rejected", (b: any) => {
    console.log("BET_REJECTED:", JSON.stringify(b));
    finish("rejected");
  });
  socket.on("cashout_accepted", (c: any) => {
    console.log("CASHOUT_ACCEPTED:", JSON.stringify(c));
    finish("cashed_out");
  });
  socket.on("bet_busted", (b: any) => {
    console.log("BET_BUSTED:", JSON.stringify(b));
    finish("busted");
  });

  setTimeout(() => {
    console.log("TIMEOUT betId=" + betId);
    finish("timeout");
  }, 90_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
