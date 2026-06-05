import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./redis/redis-io.adapter";
import { initSentry } from "./observability/sentry";
import { AllExceptionsFilter } from "./observability/all-exceptions.filter";

async function bootstrap() {
  initSentry(); // error tracking — no-op unless SENTRY_DSN is set
  const rawCors = process.env.CORS_ORIGIN?.trim();
  // "*" / empty → allow any origin (reflect it); otherwise a comma-separated allowlist.
  const corsOrigin: boolean | string[] =
    !rawCors || rawCors === "*" ? true : rawCors.split(",").map((s) => s.trim());
  if (corsOrigin === true) {
    // eslint-disable-next-line no-console
    console.warn(
      "[security] CORS is open to ALL origins — set CORS_ORIGIN to a comma-separated allowlist (e.g. https://vaultrun.app) in production.",
    );
  }
  const app = await NestFactory.create(AppModule, { cors: { origin: corsOrigin, credentials: true } });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.useGlobalFilters(new AllExceptionsFilter());
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so a rolling deploy drains
  // cleanly: the WS Redis adapter's dispose(), RedisService.quit(), and the
  // gateway's tick/reconcile/RG interval clears all fire (matters once there are
  // multiple LB'd nodes — Phase 4).
  app.enableShutdownHooks();

  // WS transport: prefer the Redis adapter so broadcasts fan out across all
  // load-balanced WS nodes (Phase 4.1). Probe Redis; if it's unreachable fall
  // back to the in-memory adapter (identical single-node behavior) so local/CI
  // and a Redis-less node still serve WS.
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const wsAdapter = new RedisIoAdapter(app, redisUrl);
  try {
    await wsAdapter.connect();
    app.useWebSocketAdapter(wsAdapter);
    console.log("[ws] Redis adapter active (multi-node fan-out enabled)");
  } catch (e: any) {
    console.warn(
      `[ws] Redis adapter unavailable (${e?.message}) — using in-memory adapter (single-node only)`,
    );
    app.useWebSocketAdapter(new IoAdapter(app));
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Vault Run API listening on http://localhost:${port}`);
}

bootstrap();
