import { io } from "socket.io-client";

const socket = io("http://localhost:3001", { transports: ["websocket"], reconnection: false });
const got = { round_state: 0, multiplier_update: 0, round_crashed: 0, round_settled: 0 };
let lastMult = 0;
let lastPhase = "";

socket.on("connect", () => console.log("connected"));
socket.on("round_state", (s: any) => {
  got.round_state++;
  if (s?.phase && s.phase !== lastPhase) {
    lastPhase = s.phase;
    console.log("phase →", s.phase);
  }
});
socket.on("multiplier_update", (m: any) => {
  got.multiplier_update++;
  lastMult = m.multiplier;
});
socket.on("round_crashed", (p: any) => {
  got.round_crashed++;
  console.log("CRASH @", p.crashMultiplier);
});
socket.on("round_settled", () => got.round_settled++);

setTimeout(() => {
  console.log("counts:", JSON.stringify(got), "lastMult:", lastMult);
  const ok = got.round_state > 0 && got.multiplier_update > 0 && got.round_crashed > 0;
  console.log(ok ? "WS SMOKE: PASS" : "WS SMOKE: FAIL");
  socket.close();
  process.exit(ok ? 0 : 1);
}, 24000);
