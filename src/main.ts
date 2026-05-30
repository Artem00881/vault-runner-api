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
  const app = await NestFactory.create(AppModule, { cors: { origin: corsOrigin, credentials: true } });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.useWebSocketAdapter(new IoAdapter(app));
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Vault Run API listening on http://localhost:${port}`);
}

bootstrap();
