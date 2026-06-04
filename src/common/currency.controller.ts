import { Controller, Get, Header } from "@nestjs/common";
import { listCurrencies } from "./currency";

/**
 * Public currency-precision discovery (Phase 3.6). Returns the canonical per-currency
 * decimals table so an embedding client can render minor units at the right scale.
 * Non-secret, identical for every tenant, immutable per deploy → no auth (like
 * /api/leaderboard, /api/fairness). Cacheable.
 */
@Controller("api/currencies")
export class CurrencyController {
  @Get()
  @Header("Cache-Control", "public, max-age=3600")
  list() {
    return { currencies: listCurrencies() };
  }
}
