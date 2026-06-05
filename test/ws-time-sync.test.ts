import { test, expect } from "bun:test";
import { timeSyncSchema } from "../src/game/ws-schemas";
import { GameGateway } from "../src/game/game.gateway";

/**
 * Phase 4.2 clock-sync: the `time_sync` payload schema + the gateway handler.
 *
 * The schema must accept an optional finite t0 and reject junk (Infinity/NaN/
 * string/null) so the echo never propagates a bad value. The handler must echo
 * t0, stamp serverTime, and obey the per-socket rate limit like every other
 * message. Pure schema + a stub-constructed gateway (onTimeSync only touches the
 * rate-limit map + the schema — no DB/engine needed).
 */

const valid: Array<[string, unknown, number | undefined]> = [
  ["finite t0", { t0: 123456 }, 123456],
  ["t0 = 0", { t0: 0 }, 0],
  ["missing t0", {}, undefined],
  ["unknown keys stripped", { foo: "bar" }, undefined],
];

const invalid: Array<[string, unknown]> = [
  ["Infinity t0", { t0: Infinity }],
  ["NaN t0", { t0: NaN }],
  ["string t0", { t0: "123" }],
  ["null t0", { t0: null }],
];

for (const [name, payload, expected] of valid) {
  test(`time_sync valid: ${name}`, () => {
    const r = timeSyncSchema.safeParse(payload);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.t0).toBe(expected);
  });
}

for (const [name, payload] of invalid) {
  test(`time_sync invalid: ${name} is rejected`, () => {
    expect(timeSyncSchema.safeParse(payload).success).toBe(false);
  });
}

test("onTimeSync echoes t0 + stamps serverTime", () => {
  const gw = new GameGateway({} as any, {} as any, {} as any, {} as any, {} as any);
  const before = Date.now();
  const res: any = gw.onTimeSync({ id: "c1" } as any, { t0: 999 });
  const after = Date.now();
  expect(res.ok).toBe(true);
  expect(res.t0).toBe(999);
  expect(typeof res.serverTime).toBe("number");
  expect(res.serverTime).toBeGreaterThanOrEqual(before);
  expect(res.serverTime).toBeLessThanOrEqual(after);
});

test("onTimeSync nulls a junk t0 (never echoes Infinity/NaN)", () => {
  const gw = new GameGateway({} as any, {} as any, {} as any, {} as any, {} as any);
  const res: any = gw.onTimeSync({ id: "c2" } as any, { t0: Infinity });
  expect(res.ok).toBe(true);
  expect(res.t0).toBe(null);
});

test("onTimeSync is rate-limited per socket (WS_MSG_LIMIT)", () => {
  const gw = new GameGateway({} as any, {} as any, {} as any, {} as any, {} as any);
  const client = { id: "c3" } as any;
  let limited = false;
  // Burst well past the 15 msg/s bucket on one socket → must start rejecting.
  for (let i = 0; i < 30; i++) {
    const res: any = gw.onTimeSync(client, { t0: i });
    if (res.ok === false && res.reason === "rate_limited") limited = true;
  }
  expect(limited).toBe(true);
});
