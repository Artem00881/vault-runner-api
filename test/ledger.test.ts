import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);

async function freshWallet(balance: bigint): Promise<string> {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      username: "t_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "t" } },
    },
    include: { wallets: true },
  });
  return user.wallets[0].id;
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

test("debit then credit update balance and write ledger rows", async () => {
  const w = await freshWallet(10000n);
  await ledger.debit(w, 100n, "bet_debit", `t1:debit`, { refType: "bet", refId: randomUUID() });
  expect(await ledger.getBalance(w)).toBe(9900n);
  await ledger.credit(w, 250n, "payout_credit", `t1:credit`);
  expect(await ledger.getBalance(w)).toBe(10150n);

  const rows = await prisma.ledgerTransaction.findMany({ where: { walletId: w } });
  expect(rows.length).toBe(2);
  expect(rows.find((r) => r.type === "bet_debit")?.amount).toBe(-100n);
  expect(rows.find((r) => r.type === "payout_credit")?.amount).toBe(250n);
});

test("debit beyond balance is rejected and leaves balance unchanged", async () => {
  const w = await freshWallet(50n);
  await expect(ledger.debit(w, 100n, "bet_debit", `t2:debit`)).rejects.toThrow("insufficient_balance");
  expect(await ledger.getBalance(w)).toBe(50n);
  const rows = await prisma.ledgerTransaction.findMany({ where: { walletId: w } });
  expect(rows.length).toBe(0);
});

test("same idempotency key applies exactly once", async () => {
  const w = await freshWallet(10000n);
  const key = "t3:bet:" + randomUUID();
  const a = await ledger.debit(w, 100n, "bet_debit", key);
  const b = await ledger.debit(w, 100n, "bet_debit", key);
  expect(a.id).toBe(b.id);
  expect(await ledger.getBalance(w)).toBe(9900n);
  const rows = await prisma.ledgerTransaction.findMany({ where: { walletId: w } });
  expect(rows.length).toBe(1);
});

test("concurrent same-key debits apply exactly once", async () => {
  const w = await freshWallet(10000n);
  const key = "t4:bet:" + randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => ledger.debit(w, 100n, "bet_debit", key)),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  expect(ok.length).toBe(12); // all resolve (idempotent), none throw
  expect(await ledger.getBalance(w)).toBe(9900n); // applied once
  const rows = await prisma.ledgerTransaction.findMany({ where: { walletId: w } });
  expect(rows.length).toBe(1);
});

test("concurrent different-key debits all apply with no lost update", async () => {
  const w = await freshWallet(10000n);
  const n = 20;
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      ledger.debit(w, 100n, "bet_debit", `t5:${i}:` + randomUUID()),
    ),
  );
  expect(await ledger.getBalance(w)).toBe(10000n - BigInt(n) * 100n); // 8000
  const rows = await prisma.ledgerTransaction.findMany({ where: { walletId: w } });
  expect(rows.length).toBe(n);
  // balance never went negative and the final snapshot matches
  expect(await ledger.getBalance(w)).toBe(8000n);
});
