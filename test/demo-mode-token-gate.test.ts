import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";

/**
 * Phase 3 — demo / fun mode, launch-token layer.
 *
 * A play-money "fun mode" launch is opt-in PER LAUNCH (the operator signs `demo`
 * into the launch token) and gated PER OPERATOR by `demoEnabled` (a compliance
 * capability, OFF by default — some jurisdictions restrict demo gambling). This
 * proves:
 *   1. demo:true + operator demoEnabled:true  → verified, VerifiedLaunch.demo === true.
 *   2. demo:true + operator demoEnabled:false → rejected `demo_not_allowed`.
 *   3. demo absent/false                       → demo === false (real-money, back-compat).
 *   4. the `demo` claim is UN-FORGEABLE: a token carrying demo:true but signed with
 *      the wrong secret is rejected at the signature (`invalid_launch_token`), never
 *      reaching — let alone passing — the demo gate.
 */

const jwt = new JwtService({ secret: "demo-gate-secret" });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);

const createdOperatorIds: string[] = [];

async function freshOperator(opts: { demoEnabled: boolean; currency?: string }) {
  const op = await prisma.operator.create({
    data: {
      code: "op-demo-gate-" + randomUUID().slice(0, 8),
      name: "Demo Gate Operator",
      enabled: true,
      demoEnabled: opts.demoEnabled,
      launchSecret: "secret-" + randomUUID(),
      currencies: [opts.currency ?? "EUR"],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  if (createdOperatorIds.length) {
    await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  }
  await prisma.$disconnect();
});

test("1. demo:true launch on a demo-ENABLED operator verifies and surfaces demo=true", async () => {
  const op = await freshOperator({ demoEnabled: true });
  const token = await launch.issue({ operatorId: op.id, playerId: "p1", currency: "EUR", demo: true });
  const v = await launch.verify(token);
  expect(v.demo).toBe(true);
  expect(v.operatorId).toBe(op.id);
  expect(v.currency).toBe("EUR");
});

test("2. demo:true launch on a demo-DISABLED operator is rejected demo_not_allowed", async () => {
  const op = await freshOperator({ demoEnabled: false });
  const token = await launch.issue({ operatorId: op.id, playerId: "p2", currency: "EUR", demo: true });
  await expect(launch.verify(token)).rejects.toThrow(/demo_not_allowed/);

  // The operator is still perfectly usable for REAL launches — the gate is
  // demo-specific, not an operator-wide block.
  const realToken = await launch.issue({ operatorId: op.id, playerId: "p2", currency: "EUR" });
  const v = await launch.verify(realToken);
  expect(v.demo).toBe(false);
});

test("3. a launch with no demo flag is real-money (demo=false) — back-compat", async () => {
  const op = await freshOperator({ demoEnabled: true }); // even when demo is allowed…
  const token = await launch.issue({ operatorId: op.id, playerId: "p3", currency: "EUR" }); // …none requested
  const v = await launch.verify(token);
  expect(v.demo).toBe(false);
});

test("4. demo:true is UN-FORGEABLE — a wrong-secret token is rejected at the signature, not the gate", async () => {
  // Operator ALLOWS demo, so if the signature check were bypassable the forged
  // demo launch would sail through. It must instead fail at signature verification.
  const op = await freshOperator({ demoEnabled: true });
  const forger = new JwtService({ secret: "attacker-secret" });
  const forged = await forger.signAsync(
    { operatorId: op.id, playerId: "evil", currency: "EUR", demo: true },
    { jwtid: randomUUID() },
  );
  await expect(launch.verify(forged)).rejects.toThrow(/invalid_launch_token/);
});
