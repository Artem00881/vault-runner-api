import { z } from "zod";

/**
 * Zod schemas for inbound WebSocket message payloads (game.gateway).
 *
 * Kept in their own module so they can be unit-tested in isolation (audit H3
 * regression) without importing the gateway's NestJS/socket.io runtime, and so
 * the gateway and the tests validate the SAME schema (no drift).
 */

// place_bet payload. .finite() rejects Infinity / NaN, which otherwise pass
// .positive() and then throw in BigInt(Math.floor(amount)) before the bet
// try-block, surfacing as an unhandled rejection instead of invalid_amount
// (audit H3). Same guard on the optional autoCashout target.
export const placeSchema = z.object({
  panel: z.enum(["A", "B"]),
  amount: z.number().finite().positive(),
  autoCashout: z.number().finite().gt(1).optional(),
});

// cash_out / cancel_bet payload.
export const panelSchema = z.object({ panel: z.enum(["A", "B"]) });
