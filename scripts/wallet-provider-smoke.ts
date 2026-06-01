/**
 * Boot smoke: stand up the full Nest DI graph (no HTTP server, no port) and
 * print which WalletProvider the WALLET_PROVIDER token resolves to. Verifies the
 * module wiring — especially that WALLET_PROVIDER_TYPE=operator now builds the
 * SeamlessOperatorWallet instead of throwing.
 *
 *   WALLET_PROVIDER_TYPE=operator GAME_AUTOSTART=false \
 *   DATABASE_URL=... REDIS_URL=... JWT_SECRET=x bun scripts/wallet-provider-smoke.ts
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { WALLET_PROVIDER } from "../src/wallet/wallet-provider";

const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
const provider = ctx.get(WALLET_PROVIDER);
console.log(
  `WALLET_PROVIDER_TYPE=${process.env.WALLET_PROVIDER_TYPE ?? "internal"} → ${provider?.constructor?.name}`,
);
await ctx.close();
process.exit(0);
