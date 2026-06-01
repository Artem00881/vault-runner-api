import { Controller, Get, Header } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Prometheus scrape endpoint (plain-text exposition format). */
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4")
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
