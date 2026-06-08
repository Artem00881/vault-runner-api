import { Module } from "@nestjs/common";
import { FairnessService } from "./fairness.service";
import { FairnessController } from "./fairness.controller";
import { DailySaltProvider, EthBlockSaltProvider, SALT_PROVIDER, type SaltProvider } from "./salt.provider";
import { rpcUrls, minRpcs } from "./eth-block";

/**
 * Strict-mode boot assertion (fail CLOSED). When FAIRNESS_REQUIRE_BLOCK_SALT=true
 * (real money), every condition the grind-proof guarantee depends on must hold at
 * boot or the node must NOT start — a silently inert guard is worse than a loud crash
 * (audit H3 / M5 / M6). When NOT strict, NONE of these run, so the demo default
 * (single-RPC DailySaltProvider / EthBlockSaltProvider) is unchanged.
 *
 * Throws on the FIRST failing condition with a specific, actionable message.
 */
export function assertFairnessBootConfig(): void {
  if (process.env.FAIRNESS_REQUIRE_BLOCK_SALT !== "true") return;

  // 1. The primary salt itself must be grind-proof — a random PRIMARY salt is just as
  //    grindable as the fallback, so the strict guard would be silently inert.
  if (process.env.SALT_PROVIDER_TYPE !== "eth-block") {
    throw new Error(
      "FAIRNESS_REQUIRE_BLOCK_SALT=true requires SALT_PROVIDER_TYPE=eth-block — a random primary salt is grindable",
    );
  }

  // 2. The oracle quorum is floor(N/2)+1 of CONFIGURED RPCs; ETH_RPC_MIN<3 lets a
  //    1-2 endpoint minority meet it and spoof a salt.
  const min = minRpcs();
  if (min < 3) {
    throw new Error(
      `FAIRNESS_REQUIRE_BLOCK_SALT=true requires ETH_RPC_MIN>=3 (got ${min}) so a 1-2 endpoint minority can't meet the floor(N/2)+1 quorum`,
    );
  }

  // 3. There must actually BE >=3 configured RPCs (and at least ETH_RPC_MIN of them),
  //    else the fleet can never satisfy its own quorum and the engine just stalls.
  const urls = rpcUrls();
  if (urls.length < 3 || urls.length < min) {
    throw new Error(
      `FAIRNESS_REQUIRE_BLOCK_SALT=true requires >=3 configured ETH_RPC_URLS (and >= ETH_RPC_MIN); got ${urls.length}`,
    );
  }

  // 4. If ETH_SALT_LEAD_BLOCKS is SET it must be >=128 — the target must clear the
  //    unfinalized head by >4 epochs to be grind-proof. (Unset is fine; the floor applies.)
  const leadRaw = process.env.ETH_SALT_LEAD_BLOCKS;
  if (leadRaw !== undefined && leadRaw !== "") {
    const lead = Number(leadRaw);
    if (!(Number.isFinite(lead) && lead >= EthBlockSaltProvider.MIN_LEAD_BLOCKS)) {
      throw new Error(
        `FAIRNESS_REQUIRE_BLOCK_SALT=true requires ETH_SALT_LEAD_BLOCKS>=128 (got ${leadRaw}); the target must clear the unfinalized head by >4 epochs to be grind-proof`,
      );
    }
  }
}

/**
 * Select the salt provider from env. SALT_PROVIDER_TYPE=eth-block → grind-proof
 * future-block-hash salt (real money); else random (demo / play-money).
 *
 * Runs assertFairnessBootConfig() first so a misconfigured real-money node fails
 * CLOSED at boot rather than running with an inert grind-proof guarantee (audit H3).
 */
export function makeSaltProvider(): SaltProvider {
  assertFairnessBootConfig();
  const ethBlock = process.env.SALT_PROVIDER_TYPE === "eth-block";
  return ethBlock ? new EthBlockSaltProvider() : new DailySaltProvider();
}

@Module({
  controllers: [FairnessController],
  providers: [FairnessService, { provide: SALT_PROVIDER, useFactory: makeSaltProvider }],
  exports: [FairnessService],
})
export class FairnessModule {}
