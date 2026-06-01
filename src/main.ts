import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
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
  app.useWebSocketAdapter(new IoAdapter(app));
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Vault Run API listening on http://localhost:${port}`);
}

bootstrap();
