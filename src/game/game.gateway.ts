import { Inject, OnModuleDestroy } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { GameEngineService } from "./game-engine.service";

/**
 * Real-time bridge between the authoritative engine and clients.
 * Read-only stream for M5: snapshot on connect, multiplier stream while a round
 * runs, and relayed phase/crash/settle events. Bets (C→S) arrive in M6.
 */
@WebSocketGateway({ cors: { origin: "*" } })
export class GameGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(GameEngineService) private readonly engine: GameEngineService) {}

  afterInit(server: Server) {
    const e = this.engine.events;
    e.on("phase", (s) => server.emit("round_state", s));
    e.on("crash", (p) => server.emit("round_crashed", p));
    e.on("settle", (p) => server.emit("round_settling", p));
    e.on("settled", (p) => server.emit("round_settled", p));

    // Stream the multiplier while the round is running (~8 fps; clients interpolate).
    this.interval = setInterval(() => {
      const s = this.engine.getPublicState();
      if (s && s.phase === "running") {
        server.emit("multiplier_update", {
          roundId: s.roundId,
          multiplier: s.multiplier,
          serverTime: s.serverTime,
        });
      }
    }, 120);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  handleConnection(client: Socket) {
    const s = this.engine.getPublicState();
    if (s) client.emit("round_state", s);
  }

  @SubscribeMessage("subscribe_round")
  onSubscribe(client: Socket) {
    const s = this.engine.getPublicState();
    if (s) client.emit("round_state", s);
    return { ok: true };
  }
}
