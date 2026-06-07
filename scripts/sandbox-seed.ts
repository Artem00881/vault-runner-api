/**
 * Sandbox seeder (Phase 6 #9 demo). Drives N concurrent operator players, each
 * placing M bets across rounds against the LIVE sandbox (engine + stub wallet),
 * with VARIED amounts + auto-cashout targets. Bets settle (cashed_out / busted)
 * and are NEVER voided, so the operator reports show realistic data.
 *
 * Self-contained: mints launch tokens locally (HMAC-SHA256 JWT, the same shape
 * the API verifies) and hits the PUBLIC sandbox over HTTPS/WSS — so it runs from
 * a dev box, no access to the (read-only) sandbox container needed.
 *
 *   set -a; . vault-runner-main/.env.local; set +a
 *   bun scripts/sandbox-seed.ts --players 100 --bets 10
 *
 * Needs env: SANDBOX_OPERATOR_ID, SANDBOX_LAUNCH_SECRET (+ optional
 * SANDBOX_BASE_URL, SANDBOX_CURRENCY). Only socket.io-client + node:crypto.
 */
import { createHmac, randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";

const BASE = process.env.SANDBOX_BASE_URL ?? "https://sandbox.vaultrun.app";
const OPERATOR_ID = process.env.SANDBOX_OPERATOR_ID ?? "";
const LAUNCH_SECRET = process.env.SANDBOX_LAUNCH_SECRET ?? "";
const CURRENCY = process.env.SANDBOX_CURRENCY ?? "EUR";

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf("--" + name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
const PLAYERS = argNum("players", 100);
const BETS = argNum("bets", 10);
const MAX_SECONDS = argNum("maxSeconds", 18 * 60);

const rint = (lo: number, hi: number) => Math.floor(lo + Math.random() * (hi - lo + 1));
const rfloat = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mint an operator launch JWT (HS256), byte-compatible with what the API verifies. */
function mintLaunchToken(playerId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      operatorId: OPERATOR_ID,
      playerId,
      currency: CURRENCY,
      locale: "en",
      demo: false,
      ctx: {},
      jti: randomUUID(),
      iat: now,
      exp: now + 120,
    }),
  );
  const sig = createHmac("sha256", LAUNCH_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

interface PlayerState {
  socket: Socket;
  placed: number;
  pending: boolean;
  attempted: boolean;
  done: boolean;
}

async function main() {
  if (!OPERATOR_ID || !LAUNCH_SECRET) {
    console.error("missing SANDBOX_OPERATOR_ID / SANDBOX_LAUNCH_SECRET env");
    process.exit(1);
  }
  console.log(`seeding ${PLAYERS} players x ${BETS} bets -> ${BASE} (${CURRENCY})`);

  let accepted = 0;
  let cashed = 0;
  let busted = 0;
  let rejected = 0;
  let launched = 0;
  const players: PlayerState[] = [];

  function attachPlay(socket: Socket): PlayerState {
    const st: PlayerState = { socket, placed: 0, pending: false, attempted: false, done: false };
    socket.on("round_state", (s: any) => {
      if (st.done) return;
      if (s?.phase !== "betting") {
        st.attempted = false;
        return;
      }
      if (!st.attempted && !st.pending && st.placed < BETS) {
        st.attempted = true;
        st.pending = true;
        socket.emit(
          "place_bet",
          { panel: Math.random() < 0.5 ? "A" : "B", amount: rint(50, 300), autoCashout: Number(rfloat(1.1, 4.0).toFixed(2)) },
          () => {},
        );
      }
    });
    socket.on("bet_accepted", () => {
      accepted++;
    });
    socket.on("bet_rejected", () => {
      rejected++;
      st.pending = false;
    });
    socket.on("cashout_accepted", () => {
      cashed++;
      st.placed++;
      st.pending = false;
      if (st.placed >= BETS && !st.done) {
        st.done = true;
        try {
          socket.disconnect();
        } catch {}
      }
    });
    socket.on("bet_busted", () => {
      busted++;
      st.placed++;
      st.pending = false;
      if (st.placed >= BETS && !st.done) {
        st.done = true;
        try {
          socket.disconnect();
        } catch {}
      }
    });
    return st;
  }

  // mint + launch + connect each player (staggered to avoid a thundering herd)
  for (let i = 0; i < PLAYERS; i++) {
    try {
      const token = mintLaunchToken(`seed-p-${i}`);
      const res = await fetch(`${BASE}/api/operator/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        continue;
      }
      const j = (await res.json()) as { token?: string };
      if (!j.token) continue;
      launched++;
      const socket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token: j.token } });
      players.push(attachPlay(socket));
    } catch {
      /* skip */
    }
    await sleep(120);
  }
  console.log(`launched ${launched}/${PLAYERS} sessions`);
  if (players.length === 0) process.exit(1);

  const start = Date.now();
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const done = players.filter((p) => p.done).length;
      const elapsed = Math.floor((Date.now() - start) / 1000);
      console.log(
        `progress done=${done}/${players.length} accepted=${accepted} cashed=${cashed} busted=${busted} rejected=${rejected} t=${elapsed}s`,
      );
      if (done >= players.length || elapsed > MAX_SECONDS) {
        clearInterval(iv);
        resolve();
      }
    }, 5000);
  });

  console.log(
    `SEED_DONE players=${players.length} settled=${cashed + busted} cashed_out=${cashed} busted=${busted} rejected=${rejected}`,
  );
  players.forEach((p) => {
    try {
      p.socket.disconnect();
    } catch {}
  });
  setTimeout(() => process.exit(0), 1500);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
