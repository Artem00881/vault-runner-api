import { io } from "socket.io-client";

const BASE = process.env.SMOKE_BASE ?? `http://localhost:${process.env.PORT ?? 3001}`;

async function main() {
  // 1) guest session
  const guest = await fetch(`${BASE}/api/auth/guest`, { method: "POST" }).then((r) => r.json());
  const token = guest.token as string;
  const startBalance = guest.wallet.balance as number;
  console.log("guest:", guest.user.username, "balance:", startBalance);

  // 2) connect with auth
  const socket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token } });

  let betRound: string | null = null;
  let manualDone = false;
  const seen = { accepted: 0, cashout: 0, busted: 0, balanceUpdates: 0 };
  let lastBalance = startBalance;

  socket.on("connect", () => console.log("connected"));

  socket.on("round_state", (s: any) => {
    if (s?.phase === "betting" && s.roundId !== betRound) {
      betRound = s.roundId;
      manualDone = false;
      socket.emit("place_bet", { panel: "A", amount: 100, autoCashout: 1.3 });
      socket.emit("place_bet", { panel: "B", amount: 100 }); // manual cash-out
      console.log("→ placed A(auto 1.3x) + B(manual) on round", s.roundId.slice(0, 8));
    }
  });

  socket.on("multiplier_update", (m: any) => {
    if (!manualDone && m.multiplier >= 1.2) {
      manualDone = true;
      socket.emit("cash_out", { panel: "B" });
    }
  });

  socket.on("bet_accepted", (r: any) => { seen.accepted++; });
  socket.on("bet_rejected", (r: any) => console.log("  bet_rejected:", r.reason, r.panel));
  socket.on("cashout_accepted", (r: any) => {
    seen.cashout++;
    console.log(`  cashout ${r.auto ? "AUTO" : "MANUAL"} ${r.panel} @ ${r.multiplier}x → +${r.payout}`);
  });
  socket.on("cashout_rejected", (r: any) => console.log("  cashout_rejected:", r.reason, r.panel));
  socket.on("bet_busted", (r: any) => { seen.busted++; console.log("  BUSTED", r.panel); });
  socket.on("balance_updated", (b: any) => { seen.balanceUpdates++; lastBalance = b.balance; });

  await new Promise((r) => setTimeout(r, 30000));

  const final = await fetch(`${BASE}/api/wallet/balance`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());

  console.log("events:", JSON.stringify(seen));
  console.log("balance: start", startBalance, "| ws", lastBalance, "| db", final.balance);
  const ok = seen.accepted >= 2 && (seen.cashout + seen.busted) >= 1 && lastBalance === final.balance;
  console.log(ok ? "BET SMOKE: PASS" : "BET SMOKE: FAIL");
  socket.close();
  process.exit(ok ? 0 : 1);
}

main();
