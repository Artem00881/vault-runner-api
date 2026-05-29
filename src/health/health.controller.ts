import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  health() {
    return {
      status: "ok",
      service: "vault-runner-api",
      uptimeMs: Date.now() - this.startedAt,
      ts: new Date().toISOString(),
    };
  }
}
