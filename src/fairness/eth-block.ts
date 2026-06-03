// Minimal Ethereum JSON-RPC oracle for the provably-fair block-hash salt.
//
// Reads only the FINALIZED chain (post-Merge), so the values it returns are
// reorg-safe — a finalized block can never be re-orged out. It cross-checks the
// hash across several public RPC endpoints and only trusts a value when a MAJORITY
// of the CONFIGURED endpoints agree, so a minority of colluding/compromised RPCs can
// never spoof a salt (audit M5).

// Reputable keyless public mainnet RPCs (verified reachable 2026-06). Override
// with ETH_RPC_URLS. The oracle requires floor(N/2)+1 of them to agree on a hash.
const DEFAULT_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth-mainnet.public.blastapi.io",
  "https://eth-pokt.nodies.app",
];

function rpcUrls(): string[] {
  const env = process.env.ETH_RPC_URLS?.trim();
  return env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_RPCS;
}

/**
 * Minimum number of CONFIGURED RPCs the oracle will trust. Default 1 (dev/demo can
 * run a small fleet); a REAL-MONEY deploy MUST set ETH_RPC_MIN >= 3 so the majority
 * quorum (floor(N/2)+1) can't be met by just one or two endpoints (audit M5).
 */
function minRpcs(): number {
  const n = Number(process.env.ETH_RPC_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function timeoutMs(): number {
  const n = Number(process.env.ETH_RPC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

async function call(url: string, method: string, params: unknown[]): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} http ${res.status}`);
    const j: any = await res.json();
    if (j.error) throw new Error(`${url} rpc ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function getBlock(url: string, tag: string): Promise<{ number: number; hash: string } | null> {
  const b = await call(url, "eth_getBlockByNumber", [tag, false]);
  if (!b || !b.number || !b.hash) return null;
  return { number: Number(BigInt(b.number)), hash: String(b.hash).toLowerCase() };
}

/** Latest finalized block number, from the first RPC that answers. */
export async function finalizedBlockNumber(): Promise<number> {
  let lastErr: unknown;
  for (const url of rpcUrls()) {
    try {
      const b = await getBlock(url, "finalized");
      if (b) return b.number;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`eth oracle: no RPC returned a finalized block (${String(lastErr)})`);
}

/**
 * Hash (0x-prefixed, lowercase) of block `target` IF it is finalized and enough
 * RPCs agree; otherwise null — meaning "not finalized yet" or "not confident".
 * Reorg-safe: it only ever reads finalized blocks.
 */
export async function finalizedBlockHash(target: number): Promise<string | null> {
  const urls = rpcUrls();
  // Fail closed on an under-provisioned fleet (real-money sets ETH_RPC_MIN>=3) so the
  // majority quorum can't be satisfied by one or two endpoints (audit M5).
  if (urls.length < minRpcs()) {
    throw new Error(
      `eth oracle: ${urls.length} RPC(s) configured < required minimum ${minRpcs()} (set ETH_RPC_URLS / ETH_RPC_MIN)`,
    );
  }
  // Quorum is a MAJORITY of CONFIGURED RPCs, not of responders: a down/compromised RPC
  // counts AGAINST the quorum, so a minority can never inject a salt (audit M5).
  const need = Math.floor(urls.length / 2) + 1;

  const tag = "0x" + target.toString(16);
  const votes = new Map<string, number>(); // hash -> agreeing RPC count
  let finalizedSomewhere = false;

  for (const url of urls) {
    try {
      const head = await getBlock(url, "finalized");
      if (!head || head.number < target) continue; // target not finalized on this RPC yet
      finalizedSomewhere = true;
      const blk = await getBlock(url, tag);
      if (blk?.hash) votes.set(blk.hash, (votes.get(blk.hash) ?? 0) + 1);
    } catch {
      // skip this RPC — it simply doesn't count toward the (configured-majority) quorum
    }
  }

  if (!finalizedSomewhere) return null; // future block — not finalized anywhere yet

  // Pick the top hash, then REFUSE if two hashes tie for that top count (ambiguous,
  // computed order-independently) and require a configured-majority. Else null this pass.
  let best: string | null = null;
  let bestN = 0;
  for (const [h, n] of votes) {
    if (n > bestN) {
      best = h;
      bestN = n;
    }
  }
  const tiedForTop = [...votes.values()].filter((n) => n === bestN).length > 1;
  if (bestN === 0 || tiedForTop) return null; // no votes, or an ambiguous top tie
  return bestN >= need ? best : null;
}
