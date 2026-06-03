import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import { startSandboxOperator, type SandboxOperator } from "./helpers/sandbox-operator";

/**
 * Audit H2 (operability) — the pending-payout BACKLOG REPORTING.
 *
 * Companion to payout-reconcile-h2.test.ts (which proves recovery). Here we
 * prove the *observability* half added on top of 426ab34:
 *   - BetsService.countPendingPayouts() returns the exact count of
 *     `payout_pending` bets (and 0 when there are none).
 *   - reconcilePendingPayouts() refreshes the gauges via reportPendingBacklog():
 *       vaultrun_pending_payouts              == live pending count
 *       vaultrun_pending_payout_oldest_seconds == age of the oldest by settledAt
 *     When the operator is DOWN the won bets stay pending, so the gauges reflect
 *     the backlog; a bet whose settledAt is > PAYOUT_PENDING_ALERT_SEC old also
 *     trips the loud log.error (we capture it).
 *   - Once the operator is healthy and the backlog clears, both gauges fall to 0.
 *
 * Needs docker Postgres+Redis. We drive the production GameSessionService.resolver()
 * so the operator-mode provider maps walletId → operator session exactly like prod.
 *
 * Because count/gauge reflect the WHOLE game_bets table (shared dev DB), every
 * assertion is anchored to a baseline captured at the start and expressed as a
 * delta, so a stray pending row from another run can never make this flaky.
 */

const JWT_SECRET = "h2-backlog-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt);
const risk = new RiskService();
const metrics = new MetricsService();

// reconcile/cashOut never touch the engine via this path, but the ctor wants one.
const stubEngine: any = {
  getPublicState: () => null,
  currentMultiplier: () => 1.0,
};

// Track synthetic rows for FK-safe teardown.
const createdOperatorIds: string[] = [];
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdBetIds: string[] = [];
const sandboxes: SandboxOperator[] = [];

/** Read a prom-client gauge's current scalar value (registers a default label only). */
async function gaugeValue(g: { get: () => Promise<{ values: { value: number }[] }> }): Promise<number> {
  const m = await g.get();
  return m.values[0]?.value ?? 0;
}

/** A FK-valid round so a Bet can reference it (rounds → seed → chain). */
async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 4_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic, distinct range
      commitHash: "h2blcommit-" + randomUUID(),
      length: 2,
      salt: "h2blsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h2blh-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "crashed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** Launch an operator player → a session whose walletId the resolver maps. */
async function launchPlayer(currency: string, playerId: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-h2bl-" + randomUUID().slice(0, 8),
      name: "H2 Backlog Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  const launchToken = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  const session = await sessions.openFromToken(launchToken);
  const userId = (await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } })).userId;
  return { op, session, userId, walletId: session.walletId };
}

/**
 * Seed a Bet already in payout_pending (the state cashOut leaves on a stuck win).
 * Each bet gets its OWN fresh round so the (round_id, user_id, panel) unique
 * constraint never collides when one player has several pending bets.
 */
async function pendingBet(opts: {
  userId: string;
  walletId: string;
  amount: bigint;
  payout: bigint;
  cashoutMult: number;
  settledAt?: Date;
}): Promise<string> {
  const roundId = await freshRound();
  const id = randomUUID();
  await prisma.bet.create({
    data: {
      id,
      roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: "A",
      amount: opts.amount,
      status: "payout_pending",
      cashoutMult: opts.cashoutMult,
      payout: opts.payout,
      debitTxId: null,
      payoutTxId: null,
      settledAt: opts.settledAt ?? new Date(),
    },
  });
  createdBetIds.push(id);
  return id;
}

/** Operator-mode BetsService wired to a sandbox via the production resolver. */
function operatorBets(sandbox: SandboxOperator, timeoutMs = 200) {
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: sandbox.apiKey }),
    { timeoutMs },
  );
  // maxRetries:1 so one operator failure fully exhausts retries in a pass.
  const provider = new SeamlessOperatorWallet(client, sessions.resolver(), { maxRetries: 1 });
  return new BetsService(prisma, provider, stubEngine, risk, metrics);
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe + leave NO synthetic payout_pending rows behind. Order:
  // bets → rounds → seeds → chains; then operator-tagged users; then operators.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  for (const s of sandboxes) s.stop();
  await prisma.$disconnect();
});

test("H2 backlog: countPendingPayouts() returns the exact number of payout_pending bets (delta over baseline) and is 0 against a clean baseline", async () => {
  const currency = "EUR";
  const playerId = "p-count-" + randomUUID().slice(0, 6);
  const { userId, walletId } = await launchPlayer(currency, playerId);

  // A probe BetsService — counting needs no wallet provider, so leave it unset.
  const counter = new BetsService(prisma, {} as any, stubEngine, risk, metrics);

  // Baseline: whatever is already pending in the shared DB (clean dev DB == 0).
  const baseline = await counter.countPendingPayouts();

  // Seed exactly three payout_pending bets (each on its own fresh round).
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await pendingBet({ userId, walletId, amount: 100n, payout: 200n, cashoutMult: 2.0 }));
  }
  expect(await counter.countPendingPayouts()).toBe(baseline + 3);

  // Flip them out of payout_pending → the count drops back exactly to baseline.
  await prisma.bet.updateMany({ where: { id: { in: ids } }, data: { status: "cashed_out" } });
  const afterClear = await counter.countPendingPayouts();
  expect(afterClear).toBe(baseline);
  // "0 when none" — on the canonical clean dev DB the baseline is 0.
  if (baseline === 0) expect(afterClear).toBe(0);
});

test("H2 backlog: operator DOWN leaves wins pending → gauges reflect count + oldest-settledAt age, and a > threshold age fires the loud log", async () => {
  const currency = "USD";
  const playerId = "p-down-" + randomUUID().slice(0, 6);
  const startBalance = 1000;
  const { userId, walletId } = await launchPlayer(currency, playerId);

  // A sandbox we immediately STOP → every win() in the pass gets connection-refused
  // (operator fully DOWN for the whole pass, regardless of how many bets are owed).
  const downSandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(downSandbox);
  const bets = operatorBets(downSandbox, 120);

  // Baseline pending in the shared DB just before we seed.
  const baseline = await bets.countPendingPayouts();

  // The OLDEST bet: settledAt 2h ago → its age exceeds PAYOUT_PENDING_ALERT_SEC
  // (default 3600s) → exercises the > threshold log + the oldest-age gauge.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const oldBetId = await pendingBet({ userId, walletId, amount: 100n, payout: 300n, cashoutMult: 3.0, settledAt: twoHoursAgo });
  // Two more recent pending bets so the count gauge is clearly > 1.
  const recent = [
    await pendingBet({ userId, walletId, amount: 100n, payout: 150n, cashoutMult: 1.5 }),
    await pendingBet({ userId, walletId, amount: 100n, payout: 250n, cashoutMult: 2.5 }),
  ];
  const myPending = [oldBetId, ...recent];
  const seededPending = myPending.length; // 3

  // Capture the loud "STUCK operator payout" log.error fired by reportPendingBacklog.
  const errors: string[] = [];
  const origError = Logger.prototype.error;
  (Logger.prototype as any).error = function (msg: any, ...rest: any[]) {
    errors.push(String(msg));
    return origError.call(this, msg, ...rest);
  };

  let recovered: number;
  try {
    // Operator DOWN: the socket is closed → every credit throws → cashOut nothing,
    // all wins stay payout_pending; reportPendingBacklog still refreshes the gauges.
    downSandbox.stop();
    recovered = await bets.reconcilePendingPayouts();
  } finally {
    (Logger.prototype as any).error = origError;
  }

  // Nothing of ours recovered (operator was down for the whole pass).
  expect(recovered).toBe(0);

  // Our three seeds are all still pending; the live count == baseline + 3.
  const liveCount = await bets.countPendingPayouts();
  expect(liveCount).toBe(baseline + seededPending);
  const oldBet = await prisma.bet.findUniqueOrThrow({ where: { id: oldBetId } });
  expect(oldBet.status).toBe("payout_pending"); // not lost, not finalised
  expect(oldBet.payoutTxId).toBeNull();

  // Gauge 1: vaultrun_pending_payouts == the live pending count.
  expect(await gaugeValue(metrics.pendingPayouts)).toBe(liveCount);

  // Gauge 2: vaultrun_pending_payout_oldest_seconds reflects the OLDEST settledAt
  // (our 2h-old bet, unless the shared DB already had something even older).
  const oldestAge = await gaugeValue(metrics.pendingPayoutOldestSeconds);
  expect(oldestAge).toBeGreaterThanOrEqual(7200 - 60); // ~2h, small clock/exec margin
  // ...and it exceeds the alert threshold, so the loud log MUST have fired for it.
  expect(oldestAge).toBeGreaterThan(3600);
  expect(errors.some((e) => e.includes("STUCK operator payout") && e.includes(oldBetId))).toBe(true);

  // Tidy our still-pending bets NOW (not just in afterAll) so a later test's
  // whole-table reconcile can't sweep them and skew its own backlog count.
  await prisma.bet.updateMany({ where: { id: { in: myPending } }, data: { status: "cancelled" } });
});

test("H2 backlog: once the operator is healthy and the backlog clears, both gauges fall back to baseline (0 on a clean DB)", async () => {
  const currency = "GBP";
  const playerId = "p-clear-" + randomUUID().slice(0, 6);
  const startBalance = 2000;
  const payout = 400n;
  const { userId, walletId } = await launchPlayer(currency, playerId);

  // A HEALTHY sandbox (never armed, never stopped until teardown).
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const bets = operatorBets(sandbox);

  const baseline = await bets.countPendingPayouts();

  const ids = [
    await pendingBet({ userId, walletId, amount: 100n, payout, cashoutMult: 2.0 }),
    await pendingBet({ userId, walletId, amount: 100n, payout, cashoutMult: 2.0 }),
  ];
  expect(await bets.countPendingPayouts()).toBe(baseline + 2);

  // Healthy operator → reconcile finalises both; reportPendingBacklog then sees the
  // backlog cleared and drops the gauges to the live count.
  const recovered = await bets.reconcilePendingPayouts();
  expect(recovered).toBeGreaterThanOrEqual(2); // at least our two (others may exist in-run)

  // Our bets are finalised + credited exactly once each.
  for (const id of ids) {
    const b = await prisma.bet.findUniqueOrThrow({ where: { id } });
    expect(b.status).toBe("cashed_out");
    expect(b.payoutTxId).toBeTruthy();
  }
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance + 2 * Number(payout));

  // Core invariant: the gauge always reflects the live pending count.
  const liveCount = await bets.countPendingPayouts();
  expect(await gaugeValue(metrics.pendingPayouts)).toBe(liveCount);
  // On a clean DB our two were the only pending bets, so the backlog is now empty
  // and BOTH gauges fall to 0 (the "drops to 0 once cleared" case).
  if (liveCount === 0) {
    expect(await gaugeValue(metrics.pendingPayouts)).toBe(0);
    expect(await gaugeValue(metrics.pendingPayoutOldestSeconds)).toBe(0);
  }
});
