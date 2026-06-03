import { test, expect, afterEach, describe } from "bun:test";
import { finalizedBlockHash } from "../src/fairness/eth-block";

// ── Env / fetch isolation ────────────────────────────────────────────────────
// The oracle (src/fairness/eth-block.ts) reads ALL of its config per-call via
// rpcUrls()/minRpcs()/timeoutMs(), so mutating process.env inside each test is
// safe and takes effect immediately. We snapshot + restore the three env vars we
// touch and the global fetch so no state leaks to other suites.
const realFetch = globalThis.fetch;
const ENV_KEYS = ["ETH_RPC_URLS", "ETH_RPC_MIN", "ETH_RPC_TIMEOUT_MS"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

const blk = (n: number, hash: string) => ({ number: "0x" + n.toString(16), hash });

// Per-RPC behaviour for a single configured fleet.
type RpcSpec =
  | { kind: "down" } // errors / unreachable (fast — returns http 500, no hang)
  | { kind: "ok"; head: number; targetHash: string | null }; // finalized head + hash for `target`

// Stand up N fake RPCs at synthetic URLs and a fetch mock that dispatches by URL.
// `target` is the block whose hash we are probing; `tag` (params[0]) is either
// "finalized" (→ head) or the hex of `target` (→ that RPC's hash for it).
function fleet(target: number, specs: RpcSpec[]): string[] {
  const urls = specs.map((_s, i) => `https://rpc-${i}.fake`);
  const byUrl = new Map<string, RpcSpec>();
  urls.forEach((u, i) => byUrl.set(u, specs[i]));
  const targetTag = "0x" + target.toString(16);

  globalThis.fetch = (async (url: string, init: any) => {
    const spec = byUrl.get(String(url));
    // A "down" RPC fails fast with a non-ok response → call() throws `http 500`.
    if (!spec || spec.kind === "down") {
      return { ok: false, status: 500, json: async () => ({}) } as any;
    }
    const body = JSON.parse(init.body);
    const tag = body.params[0];
    let result: any = null;
    if (tag === "finalized") {
      result = blk(spec.head, "0xhead" + spec.head.toString(16));
    } else if (tag === targetTag) {
      result = spec.targetHash ? blk(target, spec.targetHash) : null;
    }
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as any;
  }) as any;

  process.env.ETH_RPC_URLS = urls.join(",");
  return urls;
}

const TARGET = 900; // 0x384 — same value the sibling suite uses; arbitrary.

describe("ETH oracle quorum (audit M5)", () => {
  // 1. Majority is of CONFIGURED RPCs, not responders. 4 configured, only 2 respond
  //    and agree → need=floor(4/2)+1=3 > 2 → null. FAILS-FIRST: the old code used
  //    need=Math.min(2, urls.length)=2, so 2 agreeing endpoints (a minority of the
  //    configured fleet) would have injected 0xaaa.
  test("majority of CONFIGURED required: 2-of-4 agree (2 down) → null", async () => {
    // small timeout keeps any real network path fast; here all paths are mocked.
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    fleet(TARGET, [
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "down" },
      { kind: "down" },
    ]);
    expect(await finalizedBlockHash(TARGET)).toBeNull();
  });

  // 2. Quorum met: 4 configured, 3 agree (1 down) → 3 >= 3 → the agreed hash.
  test("quorum met: 3-of-4 agree (1 down) → agreed hash", async () => {
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    fleet(TARGET, [
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "down" },
    ]);
    expect(await finalizedBlockHash(TARGET)).toBe("0xaaa");
  });

  // 3. Tie refused: 4 configured, 2 vote 0xaaa and 2 vote 0xbbb → null (ambiguous).
  //    FAILS-FIRST: the old code had no tie detection and returned whichever hash it
  //    iterated to first (insertion order → 0xaaa), spoofable by a 50/50 split.
  test("tie refused: 2 vs 2 distinct hashes → null", async () => {
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    fleet(TARGET, [
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "ok", head: 1000, targetHash: "0xbbb" },
      { kind: "ok", head: 1000, targetHash: "0xbbb" },
    ]);
    expect(await finalizedBlockHash(TARGET)).toBeNull();
  });

  // 4a. Min-fleet throws: ETH_RPC_MIN=3 but only 2 configured → throws (< minimum).
  test("min-fleet: ETH_RPC_MIN=3 with 2 RPCs → throws", async () => {
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    process.env.ETH_RPC_MIN = "3";
    fleet(TARGET, [
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
      { kind: "ok", head: 1000, targetHash: "0xaaa" },
    ]);
    expect(finalizedBlockHash(TARGET)).rejects.toThrow(/required minimum 3/);
  });

  // 4b. Min-fleet throws with a single RPC too.
  test("min-fleet: ETH_RPC_MIN=3 with 1 RPC → throws", async () => {
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    process.env.ETH_RPC_MIN = "3";
    fleet(TARGET, [{ kind: "ok", head: 1000, targetHash: "0xaaa" }]);
    expect(finalizedBlockHash(TARGET)).rejects.toThrow(/required minimum 3/);
  });

  // 4c. Default min (unset → 1): a single RPC does NOT throw and, with
  //     need=floor(1/2)+1=1, returns that RPC's hash.
  test("default min (unset): single RPC returns its hash, no throw", async () => {
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    delete process.env.ETH_RPC_MIN; // explicit: default path
    fleet(TARGET, [{ kind: "ok", head: 1000, targetHash: "0xcafe" }]);
    expect(await finalizedBlockHash(TARGET)).toBe("0xcafe");
  });

  // 5. Future block (sanity, unchanged): no RPC has `target` finalized (all heads <
  //    target) → null, regardless of fleet size.
  test("future block: all heads < target → null", async () => {
    process.env.ETH_RPC_TIMEOUT_MS = "50";
    fleet(TARGET, [
      { kind: "ok", head: TARGET - 1, targetHash: "0xaaa" },
      { kind: "ok", head: TARGET - 1, targetHash: "0xaaa" },
      { kind: "ok", head: TARGET - 1, targetHash: "0xaaa" },
    ]);
    expect(await finalizedBlockHash(TARGET)).toBeNull();
  });
});
