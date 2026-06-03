import { Module } from "@nestjs/common";
import { FairnessService } from "./fairness.service";
import { FairnessController } from "./fairness.controller";
import { DailySaltProvider, EthBlockSaltProvider, SALT_PROVIDER, type SaltProvider } from "./salt.provider";

/**
 * Select the salt provider from env. SALT_PROVIDER_TYPE=eth-block → grind-proof
 * future-block-hash salt (real money); else random (demo / play-money).
 *
 * Fail CLOSED at boot: real-money grind-proofing (FAIRNESS_REQUIRE_BLOCK_SALT=true)
 * REQUIRES the eth-block provider — otherwise the guard would be inert (it only refuses
 * the random FALLBACK, not a random PRIMARY salt, which is equally grindable). A
 * strict-but-random config must not start (audit M6/H1).
 */
export function makeSaltProvider(): SaltProvider {
  const ethBlock = process.env.SALT_PROVIDER_TYPE === "eth-block";
  if (process.env.FAIRNESS_REQUIRE_BLOCK_SALT === "true" && !ethBlock) {
    throw new Error(
      "FAIRNESS_REQUIRE_BLOCK_SALT=true requires SALT_PROVIDER_TYPE=eth-block — a random primary salt is grindable",
    );
  }
  return ethBlock ? new EthBlockSaltProvider() : new DailySaltProvider();
}

@Module({
  controllers: [FairnessController],
  providers: [FairnessService, { provide: SALT_PROVIDER, useFactory: makeSaltProvider }],
  exports: [FairnessService],
})
export class FairnessModule {}
