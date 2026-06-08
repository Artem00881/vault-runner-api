import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { OperatorSessionsController } from "../src/operator/operator-sessions.controller";
import { makeAudit } from "./helpers/audit";

/**
 * Audit M3 / F-068 — OPERATOR-AUTHED live-session revoke + the live-socket re-check.
 *
 * The operator can force-end a player's live session out-of-band via
 *   POST /api/operator/sessions/revoke  { playerId, currency? }
 * authenticated by the operator's reporting key (OperatorAuthGuard injects operatorId).
 *
 * Drives the real GameSessionService + the controller (operatorId passed directly, exactly
 * like operator-void-controller.test.ts — guard auth is covered by operator-reporting-key).
 * Proves:
 *   - the operator revoke flips every live session for its OWN player → isLive false
 *     (the place_bet defense-in-depth gate then rejects: `session_revoked`);
 *   - findNotLive (the gateway sweep's BATCHED liveness check) reports the revoked session
 *     so the sweep disconnect(true)s the socket — and a reconnect is refused at connect;
 *   - TENANT ISOLATION: operator A cannot revoke operator B's player;
 *   - currency narrowing; idempotency; body validation.
 *
 * The gateway socket itself isn't constructed here (mirrors operator-rg-enforcement.test.ts);
 * findNotLive + isLive ARE the exact queries the sweep / place_bet gate run.
 */

const JWT_SECRET = "live-revoke-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));
const controller = new OperatorSessionsController(sessions);

const createdOperatorIds: string[] = [];

async function freshOperator(currency = "EUR", demoEnabled = false) {
  const op = await prisma.operator.create({
    data: {
      code: "op-lrv-" + randomUUID().slice(0, 8),
      name: "Live Revoke Operator",
      enabled: true,
      demoEnabled,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Launch a player under an operator → a live session (reuse the op to reuse the wallet). */
async function launchPlayer(opts: { op: { id: string }; playerId: string; currency?: string; demo?: boolean }) {
  const currency = opts.currency ?? "EUR";
  const token = await launch.issue({ operatorId: opts.op.id, playerId: opts.playerId, currency, locale: "en", demo: opts.demo });
  const session = await sessions.openFromToken(token);
  return { playerId: opts.playerId, currency, session };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    // F-017: child-first teardown (RESTRICT FKs) — child rows before users, users before operators.
    for (const operatorId of createdOperatorIds) {
      const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
      await prisma.bet.deleteMany({ where: { wallet: opUser } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
      await prisma.profile.deleteMany({ where: opUser });
      await prisma.wallet.deleteMany({ where: opUser });
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M3/F-068 operator-authed live-session revoke", () => {
  test("revoke flips the player's live session non-live; the next-bet gate + sweep both see it", async () => {
    const op = await freshOperator("EUR");
    const { playerId, session } = await launchPlayer({ op, playerId: "p-" + randomUUID().slice(0, 8) });
    expect(await sessions.isLive(session.sessionId)).toBe(true);
    // The sweep's batched liveness check: a LIVE session is NOT in the not-live set.
    expect([...(await sessions.findNotLive([session.sessionId]))]).toEqual([]);

    // Operator force-terminates the session (authenticated operatorId = op.id).
    const res = await controller.revoke(op.id, { playerId });
    expect(res).toEqual({ ok: true, revoked: 1, wallets: 1 });

    // place_bet defense-in-depth gate: isLive now false → a new bet would be `session_revoked`.
    expect(await sessions.isLive(session.sessionId)).toBe(false);
    // Sweep gate: the revoked session is now reported not-live → the gateway disconnect(true)s it.
    expect([...(await sessions.findNotLive([session.sessionId]))]).toEqual([session.sessionId]);

    // SOFT: the row is kept (the operator-wallet resolver still routes in-flight settlement).
    const row = await prisma.gameSession.findUnique({ where: { id: session.sessionId } });
    expect(row).not.toBeNull();
    expect(row!.revokedAt).toBeInstanceOf(Date);

    // The H2 significant-event audit row was written for the revoke.
    const audits = await prisma.auditEvent.findMany({ where: { action: "session.revoke", operatorId: op.id } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  test("idempotent: a second revoke returns revoked:0 (already revoked)", async () => {
    const op = await freshOperator("EUR");
    const { playerId, session } = await launchPlayer({ op, playerId: "p-" + randomUUID().slice(0, 8) });

    expect(await controller.revoke(op.id, { playerId })).toEqual({ ok: true, revoked: 1, wallets: 1 });
    // Second call: the wallet still exists (wallets:1) but no LIVE session remains → revoked:0.
    expect(await controller.revoke(op.id, { playerId })).toEqual({ ok: true, revoked: 0, wallets: 1 });
    expect(await sessions.isLive(session.sessionId)).toBe(false);
  });

  test("TENANT ISOLATION: operator A cannot revoke operator B's player (same playerId)", async () => {
    // Two DISTINCT operators with the SAME external playerId — the wallet tag is prefixed with
    // the operatorId, so A's revoke must touch ONLY A's wallet, never B's.
    const playerId = "shared-" + randomUUID().slice(0, 8);
    const opA = await freshOperator("EUR");
    const opB = await freshOperator("EUR");
    const a = await launchPlayer({ op: opA, playerId });
    const b = await launchPlayer({ op: opB, playerId });
    expect(a.session.walletId).not.toBe(b.session.walletId);

    // Operator A revokes "its" player → only A's session flips; B's stays fully live.
    const res = await controller.revoke(opA.id, { playerId });
    expect(res).toEqual({ ok: true, revoked: 1, wallets: 1 }); // A sees ONLY its own wallet
    expect(await sessions.isLive(a.session.sessionId)).toBe(false);
    expect(await sessions.isLive(b.session.sessionId)).toBe(true); // B untouched

    // And the converse: B revoking the same playerId only flips B.
    expect(await controller.revoke(opB.id, { playerId })).toEqual({ ok: true, revoked: 1, wallets: 1 });
    expect(await sessions.isLive(b.session.sessionId)).toBe(false);
  });

  test("an operator revoking a player it never launched is a clean no-op (0 wallets)", async () => {
    const op = await freshOperator("EUR");
    const res = await controller.revoke(op.id, { playerId: "never-launched-" + randomUUID().slice(0, 8) });
    expect(res).toEqual({ ok: true, revoked: 0, wallets: 0 });
  });

  test("currency narrowing: a currency revokes only that currency's wallet; omitted → all", async () => {
    // Two currencies for one player under the same operator → two distinct wallets/sessions.
    const op = await prisma.operator.create({
      data: {
        code: "op-lrv-" + randomUUID().slice(0, 8),
        name: "Multi-ccy Operator",
        enabled: true,
        launchSecret: "secret-" + randomUUID(),
        currencies: ["EUR", "USDT"],
      },
    });
    createdOperatorIds.push(op.id);
    const playerId = "p-multi-" + randomUUID().slice(0, 8);
    const eur = await launchPlayer({ op, playerId, currency: "EUR" });
    const usdt = await launchPlayer({ op, playerId, currency: "USDT" });
    expect(eur.session.walletId).not.toBe(usdt.session.walletId);

    // Revoke ONLY EUR → the EUR session flips, USDT stays live.
    const onlyEur = await controller.revoke(op.id, { playerId, currency: "EUR" });
    expect(onlyEur).toEqual({ ok: true, revoked: 1, wallets: 1 });
    expect(await sessions.isLive(eur.session.sessionId)).toBe(false);
    expect(await sessions.isLive(usdt.session.sessionId)).toBe(true);

    // case-insensitive currency: a lowercase "usdt" still resolves the canonical UPPERCASE tag.
    const onlyUsdt = await controller.revoke(op.id, { playerId, currency: "usdt" });
    expect(onlyUsdt).toEqual({ ok: true, revoked: 1, wallets: 1 });
    expect(await sessions.isLive(usdt.session.sessionId)).toBe(false);
  });

  test("currency narrowing does NOT cross-match a prefix-overlapping currency", async () => {
    // A `…:EUR` prefix would WRONGLY match a `…:EURX` wallet; the in-set match must not.
    const op = await prisma.operator.create({
      data: {
        code: "op-lrv-" + randomUUID().slice(0, 8),
        name: "Prefix Operator",
        enabled: true,
        launchSecret: "secret-" + randomUUID(),
        currencies: ["EUR", "EURX"],
      },
    });
    createdOperatorIds.push(op.id);
    const playerId = "p-prefix-" + randomUUID().slice(0, 8);
    const eur = await launchPlayer({ op, playerId, currency: "EUR" });
    const eurx = await launchPlayer({ op, playerId, currency: "EURX" });

    // Revoke "EUR" must NOT touch the EURX session.
    expect(await controller.revoke(op.id, { playerId, currency: "EUR" })).toEqual({ ok: true, revoked: 1, wallets: 1 });
    expect(await sessions.isLive(eur.session.sessionId)).toBe(false);
    expect(await sessions.isLive(eurx.session.sessionId)).toBe(true); // NOT cross-matched
  });

  test("findNotLive is batched + mixed: only the revoked ids come back; unknown ids count as not-live", async () => {
    const op = await freshOperator("EUR");
    const live = await launchPlayer({ op, playerId: "p-live-" + randomUUID().slice(0, 8) });
    const dead = await launchPlayer({ op, playerId: "p-dead-" + randomUUID().slice(0, 8) });
    await controller.revoke(op.id, { playerId: dead.playerId });

    const unknownId = randomUUID();
    const notLive = await sessions.findNotLive([live.session.sessionId, dead.session.sessionId, unknownId]);
    expect(notLive.has(live.session.sessionId)).toBe(false); // still live → keep the socket
    expect(notLive.has(dead.session.sessionId)).toBe(true); // revoked → disconnect
    expect(notLive.has(unknownId)).toBe(true); // no row → also disconnect (vanished session)
    // empty input → empty set, no query.
    expect([...(await sessions.findNotLive([]))]).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M3/F-068 revoke — colon-bearing playerId must not over-match a SIBLING (SUFFIX_RE guard)", () => {
  // SECURITY REGRESSION (revokeForOperatorPlayer no-currency branch). `playerId` is
  // operator-supplied and NOT charset-validated, so it may contain ':'. The no-currency
  // branch resolves wallets by `username startsWith op:{op}:{playerId}:` — a bare prefix
  // match. With playerId "alice" (base `op:{op}:alice:`) that prefix ALSO matches a SIBLING
  // player whose id is literally `alice:x:bob` (tag `op:{op}:alice:x:bob:DEMO`), so revoking
  // "alice" would WRONGLY terminate `alice:x:bob`'s live session too. The fix filters the
  // startsWith candidates by `SUFFIX_RE = /^[^:]+(:demo)?$/` over `username.slice(base.length)`,
  // keeping only a bare-currency (optionally `:demo`) suffix — the same guard as the H4
  // anonymize resolver. Both players live under the SAME operator, so this is NOT tenant
  // isolation (covered above) — it is intra-tenant sibling-isolation on a hostile playerId.

  test("revoke(op, 'alice') with NO currency revokes ONLY alice — the sibling 'alice:x:bob' stays live", async () => {
    // One operator; "alice" is a PREFIX of the sibling id "alice:x:bob".
    const op = await freshOperator("DEMO");
    const alice = await launchPlayer({ op, playerId: "alice", currency: "DEMO" });
    const sibling = await launchPlayer({ op, playerId: "alice:x:bob", currency: "DEMO" });
    // Distinct journal wallets (the username tags differ) → distinct live sessions.
    expect(alice.session.walletId).not.toBe(sibling.session.walletId);
    expect(await sessions.isLive(alice.session.sessionId)).toBe(true);
    expect(await sessions.isLive(sibling.session.sessionId)).toBe(true);

    // Revoke "alice" (no currency → the startsWith branch). The SUFFIX_RE guard must drop the
    // sibling whose suffix `x:bob:DEMO` (after `op:{op}:alice:`) carries extra ':' segments.
    const res = await controller.revoke(op.id, { playerId: "alice" });
    expect(res).toEqual({ ok: true, revoked: 1, wallets: 1 }); // ONLY alice's wallet/session

    expect(await sessions.isLive(alice.session.sessionId)).toBe(false); // alice terminated
    expect(await sessions.isLive(sibling.session.sessionId)).toBe(true); // sibling UNTOUCHED
  });

  test("the guard does NOT over-filter the legit bare-currency + ':demo' tags — both alice wallets revoke", async () => {
    // Positive companion to the guard test: the SAME no-currency startsWith branch must STILL
    // sweep alice's real `op:{op}:alice:DEMO` AND her demo `op:{op}:alice:DEMO:demo` wallet —
    // both have a SUFFIX_RE-valid suffix (`DEMO` and `DEMO:demo`). A guard that over-filtered
    // would leave a legit session live, so revoked must be 2.
    const op = await freshOperator("DEMO", /* demoEnabled */ true);
    const real = await launchPlayer({ op, playerId: "alice", currency: "DEMO" });
    const demo = await launchPlayer({ op, playerId: "alice", currency: "DEMO", demo: true });
    expect(real.session.walletId).not.toBe(demo.session.walletId); // separate journals
    expect(await sessions.isLive(real.session.sessionId)).toBe(true);
    expect(await sessions.isLive(demo.session.sessionId)).toBe(true);

    const res = await controller.revoke(op.id, { playerId: "alice" });
    expect(res).toEqual({ ok: true, revoked: 2, wallets: 2 }); // BOTH legit alice wallets

    expect(await sessions.isLive(real.session.sessionId)).toBe(false);
    expect(await sessions.isLive(demo.session.sessionId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M3/F-068 OperatorSessionsController body validation", () => {
  // No DB needed: a CAPTURING service proves the body is validated before the service runs.
  class CapturingSessions {
    last: { operatorId: string; playerId: string; currency?: string } | null = null;
    async revokeForOperatorPlayer(operatorId: string, playerId: string, currency?: string) {
      this.last = { operatorId, playerId, currency };
      return { revoked: 1, wallets: 1 };
    }
  }
  function make() {
    const svc = new CapturingSessions();
    return { svc, controller: new OperatorSessionsController(svc as any) };
  }
  const OP = randomUUID();

  test("a missing/empty/oversized playerId → BadRequest, service NOT called", async () => {
    for (const body of [null, undefined, {}, { playerId: "" }, { playerId: 123 }, { playerId: "x".repeat(257) }, { currency: "EUR" }]) {
      const { svc, controller } = make();
      await expect(controller.revoke(OP, body)).rejects.toThrow(BadRequestException);
      expect(svc.last).toBeNull();
    }
  });

  test("a valid body forwards operatorId (from the guard) + playerId + currency verbatim", async () => {
    const { svc, controller } = make();
    const r = await controller.revoke(OP, { playerId: "player-1", currency: "EUR" });
    expect(r).toEqual({ ok: true, revoked: 1, wallets: 1 });
    expect(svc.last).toEqual({ operatorId: OP, playerId: "player-1", currency: "EUR" });
  });

  test("currency is optional", async () => {
    const { svc, controller } = make();
    await controller.revoke(OP, { playerId: "player-2" });
    expect(svc.last).toEqual({ operatorId: OP, playerId: "player-2", currency: undefined });
  });
});
