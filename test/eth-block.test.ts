import { test, expect, afterEach } from "bun:test";
import { finalizedBlockNumber, finalizedBlockHash } from "../src/fairness/eth-block";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ETH_RPC_URLS;
});

const blk = (n: number, hash: string) => ({ number: "0x" + n.toString(16), hash });

// Mock fetch with a per-URL JSON-RPC handler (params[0] is the block tag).
function mock(handler: (url: string, tag: string) => any) {
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const result = handler(String(url), body.params[0]);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as any;
  }) as any;
}

test("finalizedBlockNumber reads the finalized tag", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  mock((_u, tag) => (tag === "finalized" ? blk(1000, "0xabc") : null));
  expect(await finalizedBlockNumber()).toBe(1000);
});

test("finalizedBlockHash is null when the target block is not finalized yet", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  mock((_u, tag) => (tag === "finalized" ? blk(1000, "0xhead") : null));
  // target 1100 > finalized 1000 → future block, not ready
  expect(await finalizedBlockHash(1100)).toBeNull();
});

test("finalizedBlockHash returns the (lowercased) hash when finalized, single RPC", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  mock((_u, tag) => {
    if (tag === "finalized") return blk(1000, "0xhead");
    if (tag === "0x384") return blk(900, "0xDEADBEEF"); // 0x384 = 900
    return null;
  });
  expect(await finalizedBlockHash(900)).toBe("0xdeadbeef");
});

test("finalizedBlockHash requires agreement — divergent RPCs → null", async () => {
  process.env.ETH_RPC_URLS = "https://a.rpc,https://b.rpc";
  mock((url, tag) => {
    if (tag === "finalized") return blk(1000, "0xhead");
    if (tag === "0x384") return blk(900, url.includes("a.rpc") ? "0xaaa" : "0xbbb"); // disagree
    return null;
  });
  expect(await finalizedBlockHash(900)).toBeNull();
});

test("finalizedBlockHash returns the agreed hash when RPCs agree", async () => {
  process.env.ETH_RPC_URLS = "https://a.rpc,https://b.rpc";
  mock((_u, tag) => {
    if (tag === "finalized") return blk(1000, "0xhead");
    if (tag === "0x384") return blk(900, "0xCAFE"); // both agree
    return null;
  });
  expect(await finalizedBlockHash(900)).toBe("0xcafe");
});
