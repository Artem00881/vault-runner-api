import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import type { WalletProvider } from "../src/wallet/wallet-provider";

// Phase 0.1: BetsService now depends on the WalletProvider interface, not on
// LedgerService directly. This proves the internal ledger satisfies that
// interface and behaves identically when used through it.
const prisma = new PrismaService();
const provider: WalletProvider = new LedgerService(prisma); // must type-check

async function freshWallet(balance: bigint): Promise<string> {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      username: "wp_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "wp" } },
    },
    include: { wallets: true },
  });
  return user.wallets[0].id;
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.$disconnect(); });

test("LedgerService is a WalletProvider: debit/credit/getBalance through the interface", async () => {
  const w = await freshWallet(1000n);
  const k = randomUUID();
  const d = await provider.debit(w, 100n, "bet_debit", `wp:${k}:debit`, { refType: "bet", refId: randomUUID() });
  expect(d.balanceAfter).toBe(900n);
  expect(await provider.getBalance(w)).toBe(900n);

  const c = await provider.credit(w, 250n, "payout_credit", `wp:${k}:credit`);
  expect(c.balanceAfter).toBe(1150n);
  expect(await provider.getBalance(w)).toBe(1150n);
});

test("idempotency is preserved through the WalletProvider interface", async () => {
  const w = await freshWallet(1000n);
  const key = `wp-idem:${randomUUID()}`;
  const a = await provider.debit(w, 100n, "bet_debit", key);
  const b = await provider.debit(w, 100n, "bet_debit", key);
  expect(a.id).toBe(b.id); // same row — applied once
  expect(await provider.getBalance(w)).toBe(900n);
});
