import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { startSandboxOperator } from "./helpers/sandbox-operator";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";

/**
 * Audit C2 — multi-tenant money path, end-to-end.
 *
 * Proves the just-landed fix: an operator launch now mints a SESSION ("play")
 * JWT signed with OUR JWT_SECRET (so the WS gateway authenticates an operator
 * player exactly like a guest), the bet path resolves the wallet by `userId`
 * ALONE (no `currency:"DEMO"` filter — so a non-DEMO operator player no longer
 * throws), and in operator mode the money actually routes to the operator
 * keyed by that session's `playerId`+`currency`.
 *
 * Engine/ledger/sandbox are NOT exercised here; we drive the wallet/session
 * services directly + a real-socket sandbox operator (reusing the e2e helpers).
 */

// One secret shared by every service that signs/verifies a token with OUR
// JWT_SECRET — mirrors how AuthModule wires JwtModule. JWT_SECRET=x at runtime,
// but the launch token is signed per-operator (explicit secret), so the value
// only matters for being CONSISTENT between issuer (GameSessionService) and the
// verifier we stand in for the gateway with below.
const JWT_SECRET = "c2-session-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

// Track everything we create for FK-safe teardown.
const createdOperatorIds: string[] = [];

async function freshOperator(currency = "EUR", callbackUrl?: string | null) {
  const op = await prisma.operator.create({
    data: {
      code: "op-c2-" + randomUUID().slice(0, 8),
      name: "C2 Test Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
      ...(callbackUrl !== undefined ? { callbackUrl } : {}),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Launch a fresh operator player and consume the token → a live session. */
async function launchPlayer(opts: { currency?: string; playerId?: string } = {}) {
  const currency = opts.currency ?? "EUR";
  const playerId = opts.playerId ?? "player-" + randomUUID().slice(0, 8);
  const op = await freshOperator(currency);
  const launchToken = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  const session = await sessions.openFromToken(launchToken);
  return { op, playerId, currency, session };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe: deleting the operator cascades its GameSessions (onDelete: Cascade);
  // the journal users we created (username tagged `op:<operatorId>:…`) cascade
  // their wallets/ledger/profile. GameSession.walletId has no FK, so order is
  // safe either way — do users first by tag, then operators.
  for (const operatorId of createdOperatorIds) {
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
  }
  if (createdOperatorIds.length) {
    await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  }
  await prisma.$disconnect();
});

test("1. session token is signed with OUR secret and carries sub=local userId, currency=launch currency", async () => {
  const { op, playerId, currency, session } = await launchPlayer({ currency: "EUR" });

  // The launch returns a session ("play") token (NEW — was absent before C2).
  expect(session.token).toBeTruthy();

  // What the WS gateway does: verifyAsync(token) with the module's JWT_SECRET.
  // A JwtService configured with the SAME secret must accept it.
  const payload = await jwt.verifyAsync(session.token!);

  // `sub` is the LOCAL user id — i.e. the socket/bet actor. Confirm it points at
  // the exact local user that owns the journal wallet for this session.
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } });
  expect(payload.sub).toBe(wallet.userId);

  // The gateway relies on `currency` to label balance_updated for this player.
  expect(payload.currency).toBe(currency);
  expect(payload.currency).not.toBe("DEMO");

  // And the operator/session context rides along for downstream scoping.
  expect(payload.operatorId).toBe(op.id);
  expect(payload.playerId).toBe(playerId);
  expect(payload.sessionId).toBe(session.sessionId);
  expect(payload.kind).toBe("operator");
});

test("1b. a session token signed with a DIFFERENT secret is rejected by the gateway verifier", async () => {
  // Negative control: proves the token's validity is bound to OUR secret, not
  // just any HS256 token. (The gateway would downgrade such a socket to guest.)
  const { session } = await launchPlayer({ currency: "EUR" });
  expect(typeof session.token).toBe("string"); // not vacuously undefined
  // Sanity: OUR verifier accepts it; a wrong-secret verifier must reject it.
  await expect(jwt.verifyAsync(session.token!)).resolves.toBeTruthy();
  const wrong = new JwtService({ secret: "not-the-gateway-secret" });
  await expect(wrong.verifyAsync(session.token!)).rejects.toThrow();
});

test("2. operator player's wallet resolves by userId as NON-DEMO (old DEMO filter would throw)", async () => {
  const { session, currency } = await launchPlayer({ currency: "EUR" });
  const userId = (await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } })).userId;

  // This is exactly what BetsService.wallet() now does. It must return the EUR
  // wallet for an operator player.
  const resolved = await prisma.wallet.findFirstOrThrow({ where: { userId } });
  expect(resolved.id).toBe(session.walletId);
  expect(resolved.currency).toBe(currency);
  expect(resolved.currency).toBe("EUR");

  // Regression guard: the OLD code path (`{ userId, currency: "DEMO" }`) would
  // throw for this operator player. Prove that explicitly. (Wrapped in a thunk
  // because a bare PrismaPromise is lazy — `.rejects` needs a real promise.)
  await expect(
    (async () => { await prisma.wallet.findFirstOrThrow({ where: { userId, currency: "DEMO" } }); })(),
  ).rejects.toThrow();
});

test("3. money routes to the operator: resolved walletId → debit/credit hit the operator for the right player+currency", async () => {
  const currency = "EUR";
  const startBalance = 1000;
  const { session, playerId } = await launchPlayer({ currency });

  // In operator mode the bet path resolves the wallet by userId, then the
  // WALLET_PROVIDER (SeamlessOperatorWallet) moves money against the OPERATOR,
  // resolving walletId → session via GameSessionService.resolver(). Wire the
  // production resolver to a real-socket sandbox operator seeded for THIS player.
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance }, apiKey: "k" });
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: "k" }),
    { timeoutMs: 1000 },
  );
  const provider = new SeamlessOperatorWallet(client, sessions.resolver());

  // The bet path resolves the wallet by userId — same row we'd hand the provider.
  const userId = (await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } })).userId;
  const walletId = (await prisma.wallet.findFirstOrThrow({ where: { userId } })).id;
  expect(walletId).toBe(session.walletId);

  const ref = (id: string) => ({ refType: "bet", refId: id });
  const betKey = `bet:${randomUUID()}:debit`;
  const winKey = `bet:${randomUUID()}:payout`;

  // Debit (stake) then credit (payout) — exactly the bet → cashout shape.
  const debit = await provider.debit(walletId, 100n, "bet_debit", betKey, ref("b1"));
  expect(debit.balanceAfter).toBe(900n);

  const credit = await provider.credit(walletId, 250n, "payout_credit", winKey, ref("b1"));
  expect(credit.balanceAfter).toBe(1150n);

  // The OPERATOR is the source of truth and saw the moves for THIS player+currency.
  expect(sandbox.operator.calls.bet).toBe(1);
  expect(sandbox.operator.calls.win).toBe(1);
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(1150);

  // Balance route (WalletController.balance) reads getBalance(walletId) → the
  // operator's real balance, NOT the local journal wallet (still 0).
  expect(await provider.getBalance(walletId)).toBe(1150n);
  const local = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  expect(Number(local.balance)).toBe(0); // journal anchor only — not authoritative

  sandbox.stop();
});

test("3b. tenant isolation — a second operator's player is resolved & charged independently", async () => {
  // Two different operators, same operator-side playerId string + currency.
  // Each launch maps to its OWN local wallet/session, so the resolver keys money
  // to the correct tenant. Two sandboxes prove no cross-tenant bleed.
  const currency = "USD";
  const sharedPlayerId = "p-shared";

  const a = await launchPlayer({ currency, playerId: sharedPlayerId });
  const b = await launchPlayer({ currency, playerId: sharedPlayerId });
  expect(a.session.walletId).not.toBe(b.session.walletId); // distinct tenants → distinct wallets

  const sbA = startSandboxOperator({ seed: { [`${sharedPlayerId}:${currency}`]: 500 }, apiKey: "k" });
  const sbB = startSandboxOperator({ seed: { [`${sharedPlayerId}:${currency}`]: 800 }, apiKey: "k" });
  const provA = new SeamlessOperatorWallet(
    new HttpOperatorWalletApi(async () => ({ walletApiUrl: sbA.url, walletApiKey: "k" }), { timeoutMs: 1000 }),
    sessions.resolver(),
  );
  const provB = new SeamlessOperatorWallet(
    new HttpOperatorWalletApi(async () => ({ walletApiUrl: sbB.url, walletApiKey: "k" }), { timeoutMs: 1000 }),
    sessions.resolver(),
  );

  const ref = { refType: "bet", refId: "b1" };
  await provA.debit(a.session.walletId, 100n, "bet_debit", `bet:${randomUUID()}:debit`, ref);
  await provB.debit(b.session.walletId, 300n, "bet_debit", `bet:${randomUUID()}:debit`, ref);

  // Each operator only saw its own player's move; balances are independent.
  expect(sbA.operator.balanceOf(sharedPlayerId, currency)).toBe(400);
  expect(sbB.operator.balanceOf(sharedPlayerId, currency)).toBe(500);

  sbA.stop();
  sbB.stop();
});

test("4. launch surfaces the operator's callbackUrl when set (Phase 3 go-live)", async () => {
  // An operator WITH a return-to-lobby URL → openFromToken includes it so the embedding
  // client knows where to send the player on exit.
  const op = await freshOperator("EUR", "https://op.example/lobby");
  const token = await launch.issue({ operatorId: op.id, playerId: "p-" + randomUUID().slice(0, 8), currency: "EUR" });
  const session = await sessions.openFromToken(token);
  expect(session.callbackUrl).toBe("https://op.example/lobby");
});

test("4b. launch returns callbackUrl:null when the operator has none", async () => {
  // No callbackUrl on the operator → openFromToken returns null (not undefined/throwing).
  const op = await freshOperator("EUR"); // callbackUrl unset (DB default null)
  const token = await launch.issue({ operatorId: op.id, playerId: "p-" + randomUUID().slice(0, 8), currency: "EUR" });
  const session = await sessions.openFromToken(token);
  expect(session.callbackUrl).toBeNull();
});
