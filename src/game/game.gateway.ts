import { Inject, OnModuleDestroy } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { GameEngineService } from "./game-engine.service";
import { BetsService, type Panel } from "./bets.service";

const placeSchema = z.object({
  panel: z.enum(["A", "B"]),
  amount: z.number().positive(),
  autoCashout: z.number().gt(1).optional(),
});
const panelSchema = z.object({ panel: z.enum(["A", "B"]) });

function userRoom(userId: string) {
  return `user:${userId}`;
}

/**
 * Real-time gateway: streams the authoritative round to clients and accepts
 * money-moving actions (bet / cash-out), all validated server-side.
 */
@WebSocketGateway({ cors: { origin: "*" } })
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(GameEngineService) private readonly engine: GameEngineService,
    @Inject(BetsService) private readonly bets: BetsService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  afterInit(server: Server) {
    const e = this.engine.events;
    e.on("phase", (s) => server.emit("round_state", s));
    e.on("crash", (p) => server.emit("round_crashed", p));
    e.on("settle", (p) => this.onSettle(p));
    e.on("settled", (p) => server.emit("round_settled", p));

    this.interval = setInterval(() => this.onTick(), 120);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  async handleConnection(client: Socket) {
    // Optional auth: a JWT in the handshake lets this socket place bets.
    const token = (client.handshake.auth as any)?.token as string | undefined;
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync(token);
        client.data.userId = payload.sub;
        client.join(userRoom(payload.sub));
      } catch {
        /* unauthenticated — read-only */
      }
    }
    const s = this.engine.getPublicState();
    if (s) client.emit("round_state", s);
  }

  // ---- realtime drivers ----
  private async onTick() {
    const s = this.engine.getPublicState();
    if (!s || s.phase !== "running") return;
    this.server.emit("multiplier_update", {
      roundId: s.roundId,
      multiplier: s.multiplier,
      serverTime: s.serverTime,
    });
    const cashed = await this.bets.evaluateAutoCashouts(s.multiplier);
    for (const c of cashed) {
      this.server.to(userRoom(c.userId!)).emit("cashout_accepted", {
        panel: c.panel,
        multiplier: c.multiplier,
        payout: c.payout,
        auto: true,
      });
      this.server.to(userRoom(c.userId!)).emit("balance_updated", { currency: "DEMO", balance: c.balance });
    }
  }

  private async onSettle(p: { roundId: string }) {
    const busted = await this.bets.settleRound(p.roundId);
    for (const b of busted) {
      this.server.to(userRoom(b.userId)).emit("bet_busted", { panel: b.panel });
    }
  }

  // ---- client → server ----
  @SubscribeMessage("subscribe_round")
  onSubscribe(@ConnectedSocket() client: Socket) {
    const s = this.engine.getPublicState();
    if (s) client.emit("round_state", s);
    return { ok: true };
  }

  @SubscribeMessage("place_bet")
  async onPlaceBet(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = placeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const { panel, amount, autoCashout } = parsed.data;
    const r = await this.bets.placeBet(userId, panel as Panel, amount, autoCashout);
    const event = r.ok ? "bet_accepted" : "bet_rejected";
    client.emit(event, r);
    if (r.ok && r.balance !== undefined) {
      client.emit("balance_updated", { currency: "DEMO", balance: r.balance });
    }
    return r;
  }

  @SubscribeMessage("cancel_bet")
  async onCancelBet(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = panelSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const r = await this.bets.cancelBet(userId, parsed.data.panel as Panel);
    client.emit(r.ok ? "bet_cancelled" : "bet_rejected", r);
    if (r.ok && r.balance !== undefined) {
      client.emit("balance_updated", { currency: "DEMO", balance: r.balance });
    }
    return r;
  }

  @SubscribeMessage("cash_out")
  async onCashOut(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: "not_authenticated" };
    const parsed = panelSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid_payload" };
    const r = await this.bets.cashOut(userId, parsed.data.panel as Panel);
    client.emit(r.ok ? "cashout_accepted" : "cashout_rejected", r);
    if (r.ok && r.balance !== undefined) {
      client.emit("balance_updated", { currency: "DEMO", balance: r.balance });
    }
    return r;
  }
}
