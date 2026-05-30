import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*";
  const app = await NestFactory.create(AppModule, { cors: { origin: corsOrigin } });
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.useWebSocketAdapter(new IoAdapter(app));
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Vault Run API listening on http://localhost:${port}`);
}

bootstrap();
