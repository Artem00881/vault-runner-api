import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { MetricsAuthGuard } from "./metrics-auth.guard";

@Controller("metrics")
@UseGuards(MetricsAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Prometheus scrape endpoint (plain-text exposition format). */
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
