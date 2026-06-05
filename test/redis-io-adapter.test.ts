import { describe, it, expect } from "bun:test";
import { RedisIoAdapter } from "../src/redis/redis-io.adapter";

// Phase 4.1: the Redis-backed Socket.IO adapter must (a) activate against a
// reachable Redis so broadcasts fan out across nodes, and (b) DEGRADE gracefully
// (throw → caller falls back to in-memory) when Redis is absent, without hanging
// boot. The app arg is unused by connect()/active/dispose, so a stub is fine.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("RedisIoAdapter (Phase 4.1)", () => {
  it("connects against a reachable Redis and reports active", async () => {
    const a = new RedisIoAdapter(undefined as any, REDIS_URL, 2000);
    try {
      await a.connect();
      expect(a.active).toBe(true);
    } finally {
      await a.dispose();
    }
    // dispose() clears the clients → no longer reports the live pair.
  });

  it("throws and stays inactive (degrades) fast when Redis is unreachable", async () => {
    // Nothing listens on this port → connection refused; the bounded probe must
    // throw rather than retry forever, so boot can fall back to in-memory.
    const a = new RedisIoAdapter(undefined as any, "redis://127.0.0.1:6399", 800);
    let threw = false;
    const t0 = Date.now();
    try {
      await a.connect();
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;
    expect(threw).toBe(true);
    expect(a.active).toBe(false);
    // Fails fast (around the 800ms probe timeout), never hangs boot.
    expect(elapsed).toBeLessThan(2500);
    await a.dispose();
  });
});
