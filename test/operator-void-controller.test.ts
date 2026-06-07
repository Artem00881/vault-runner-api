import { test, expect, describe } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { OperatorBetsController } from "../src/game/operator-bets.controller";

/**
 * Controller layer of the operator VOID (POST /api/operator/bets/:betId/void).
 * No DB / no guard needed - we invoke the handler method directly with a fake
 * BetsService that CAPTURES the (operatorId, betId, reason) it is handed. This is
 * the only caller of the private `readReason`, so driving it through `void()`
 * exercises readReason end to end:
 *   - non-string reason -> undefined
 *   - control characters (CR LF TAB NUL DEL) -> replaced with a space then collapsed
 *   - surrounding/duplicate whitespace collapsed + trimmed
 *   - length capped at 500
 *   - whitespace-only / empty -> undefined
 * Plus: an invalid (non-UUID) betId is rejected BEFORE BetsService is touched.
 *
 * (Control chars are constructed from CODE POINTS - no control-char literals in
 *  source, matching the controller's own convention.)
 */

class CapturingBets {
  last: { operatorId: string; betId: string; reason?: string } | null = null;
  async voidBet(operatorId: string, betId: string, reason?: string) {
    this.last = { operatorId, betId, reason };
    return { ok: true, betId, status: "voided", reversed: true, refundedStake: "0", reclaimedPayout: "0" };
  }
}

function make() {
  const bets = new CapturingBets();
  const controller = new OperatorBetsController(bets as any);
  return { bets, controller };
}

const OP = randomUUID();
const BET = randomUUID();
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const TAB = String.fromCharCode(0x09);
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);

const hasControlChar = (s: string) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x20 || c === 0x7f;
  });

describe("OperatorBetsController.void - readReason sanitisation", () => {
  test("a non-string reason -> undefined (prototype-pollution-safe: only the known key)", async () => {
    const cases: unknown[] = [
      null,
      undefined,
      {},
      { reason: 123 },
      { reason: true },
      { reason: { nested: "x" } },
      { reason: ["a"] },
      "not-an-object",
      { notReason: "ignored" },
    ];
    for (const body of cases) {
      const { bets, controller } = make();
      await controller.void(OP, BET, body);
      expect(bets.last!.reason).toBeUndefined();
    }
  });

  test("control characters are replaced and whitespace collapsed/trimmed", async () => {
    const { bets, controller } = make();
    // CR LF TAB NUL DEL between words, plus padding + a double space.
    const dirty = `  fraud${CR}${LF}check${TAB}done${NUL}here${DEL}  again  `;
    await controller.void(OP, BET, { reason: dirty });
    // Each control char -> " ", then /\s+/ -> single space, then trim.
    expect(bets.last!.reason).toBe("fraud check done here again");
    // No raw control char (code < 0x20 or == 0x7f) survives (log-injection guard).
    expect(hasControlChar(bets.last!.reason!)).toBe(false);
  });

  test("a clean short reason passes through unchanged", async () => {
    const { bets, controller } = make();
    await controller.void(OP, BET, { reason: "duplicate bet refund" });
    expect(bets.last!.reason).toBe("duplicate bet refund");
  });

  test("length is capped at 500 characters", async () => {
    const { bets, controller } = make();
    await controller.void(OP, BET, { reason: "x".repeat(1000) });
    expect(bets.last!.reason!.length).toBe(500);
    expect(bets.last!.reason).toBe("x".repeat(500));
  });

  test("a long reason is capped AFTER sanitisation (collapsed, then sliced)", async () => {
    const { bets, controller } = make();
    // 600 "a b" groups collapse to "a b a b ..." then cap at 500.
    const reason = Array.from({ length: 600 }, () => `a${TAB}b`).join("  ");
    await controller.void(OP, BET, { reason });
    expect(bets.last!.reason!.length).toBe(500);
    expect(hasControlChar(bets.last!.reason!)).toBe(false);
  });

  test("whitespace-only / control-only / empty -> undefined", async () => {
    const reasons = ["", "    ", `${TAB}${LF}${CR}`, `${NUL}${NUL}`, ` ${DEL} `];
    for (const reason of reasons) {
      const { bets, controller } = make();
      await controller.void(OP, BET, { reason });
      expect(bets.last!.reason).toBeUndefined();
    }
  });

  test("the operatorId and betId are forwarded verbatim to voidBet", async () => {
    const { bets, controller } = make();
    await controller.void(OP, BET, { reason: "ok" });
    expect(bets.last!.operatorId).toBe(OP);
    expect(bets.last!.betId).toBe(BET);
  });
});

describe("OperatorBetsController.void - betId validation", () => {
  test("a non-UUID betId -> BadRequest('invalid betId') and voidBet is NOT called", async () => {
    for (const bad of ["not-a-uuid", "", "123", BET + "x", "../../etc"]) {
      const { bets, controller } = make();
      await expect(controller.void(OP, bad, { reason: "x" })).rejects.toThrow(BadRequestException);
      expect(bets.last).toBeNull(); // rejected before BetsService
    }
  });

  test("a well-formed UUID betId reaches voidBet", async () => {
    const { bets, controller } = make();
    await controller.void(OP, BET, {});
    expect(bets.last).not.toBeNull();
    expect(bets.last!.betId).toBe(BET);
  });
});
