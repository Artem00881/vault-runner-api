import { test, expect, afterEach } from "bun:test";
import { EthBlockSaltProvider } from "../src/fairness/salt.provider";

/**
 * Audit H3 (F-005/006/007/008) — grind-proof salt anchoring.
 *
 * The committed target block must clear the UNFINALIZED head by >= MIN_LEAD_BLOCKS
 * (128 ≈ 4 epochs), so it provably does NOT exist at commit time and its hash is
 * unknowable → ungrindable. The salt is still taken ONLY from the FINALIZED chain at
 * resolve() time (reorg-safe). These exercise EthBlockSaltProvider directly against a
 * mocked JSON-RPC (no DB / no engine needed).
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ETH_RPC_URLS;
  delete process.env.ETH_SALT_LEAD_BLOCKS;
});

const blk = (n: number, hash: string) => ({ number: "0x" + n.toString(16), hash });

// Per-URL JSON-RPC mock (params[0] is the block tag) — same helper shape as eth-block.test.ts.
function mock(handler: (url: string, tag: string) => any) {
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const result = handler(String(url), body.params[0]);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as any;
  }) as any;
}

const HEAD = 1000; // unfinalized "latest"
const FINALIZED = 934; // finalized head (66 behind latest)
const HASH = "0xCAFEBABE";

/** A mock chain where `latest`=HEAD, `finalized`=fin, and block `target` (if finalized) has HASH. */
function chain(fin: number, target: number) {
  const tag = "0x" + target.toString(16);
  mock((_u, t) => {
    if (t === "latest") return blk(HEAD, "0xhead");
    if (t === "finalized") return blk(fin, "0xfin");
    if (t === tag && target <= fin) return blk(target, HASH);
    return null;
  });
}

test("commit() anchors on the UNFINALIZED head + 128 floor (was finalized+10, BEHIND head → grindable)", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  chain(FINALIZED, 1128);
  const p = new EthBlockSaltProvider();
  const c = await p.commit();

  // FAILS-FIRST: the OLD impl committed finalized(934)+10 = 944, which is BEHIND the
  // head (1000) — the block ALREADY EXISTS at commit → its hash is knowable → grindable.
  // The new impl commits latest(1000)+128 = 1128, which does NOT exist yet.
  expect(c.targetBlock).toBe(HEAD + 128); // 1128
  expect(c.targetBlock!).toBeGreaterThan(HEAD); // strictly past the unfinalized head
  expect(c.targetBlock!).toBeGreaterThan(FINALIZED);
  expect(c.salt).toBeNull(); // never known at commit
  expect(c.source).toBe("eth-block");
  expect(c.targetChain).toBe("ethereum");
});

test("ETH_SALT_LEAD_BLOCKS is a FLOOR-raise: 10 clamps UP to 128; 256 is honored", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";

  process.env.ETH_SALT_LEAD_BLOCKS = "10"; // below floor → clamps up to 128
  chain(FINALIZED, 1128);
  expect((await new EthBlockSaltProvider().commit()).targetBlock).toBe(HEAD + 128); // 1128

  process.env.ETH_SALT_LEAD_BLOCKS = "256"; // above floor → honored
  chain(FINALIZED, 1256);
  expect((await new EthBlockSaltProvider().commit()).targetBlock).toBe(HEAD + 256); // 1256
});

test("invariant: targetBlock - HEAD >= 128 (default and clamped)", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  chain(FINALIZED, 1128);
  const def = await new EthBlockSaltProvider().commit();
  expect(def.targetBlock! - HEAD).toBeGreaterThanOrEqual(128);

  process.env.ETH_SALT_LEAD_BLOCKS = "1"; // far below floor
  chain(FINALIZED, 1128);
  const clamped = await new EthBlockSaltProvider().commit();
  expect(clamped.targetBlock! - HEAD).toBeGreaterThanOrEqual(128);
});

test("resolve() is null while finalized < target, then returns the lowercased hash once finalized", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  const p = new EthBlockSaltProvider();
  const commitment = { source: "eth-block", salt: null, targetChain: "ethereum", targetBlock: 1128 };

  // Target 1128 not finalized yet (finalized 934) → not ready.
  chain(FINALIZED, 1128);
  expect(await p.resolve(commitment)).toBeNull();

  // Finalized advances past the target → resolve yields the (lowercased) block hash.
  chain(1200, 1128); // finalized 1200 >= target 1128
  expect(await p.resolve(commitment)).toBe(HASH.toLowerCase());
});

test("reorg-safe: target exists at latest head but is NOT finalized → resolve() still null", async () => {
  process.env.ETH_RPC_URLS = "https://rpc.example";
  const p = new EthBlockSaltProvider();
  const commitment = { source: "eth-block", salt: null, targetChain: "ethereum", targetBlock: 1128 };

  // latest=1200 (target 1128 EXISTS at the unfinalized head) but finalized=1100 (< 1128).
  // The salt must come ONLY from the finalized chain, so this is still not ready.
  mock((_u, t) => {
    if (t === "latest") return blk(1200, "0xhead");
    if (t === "finalized") return blk(1100, "0xfin");
    if (t === "0x" + (1128).toString(16)) return blk(1128, HASH); // exists at head, just not final
    return null;
  });
  expect(await p.resolve(commitment)).toBeNull(); // reorg-safe: finalized-only
});
