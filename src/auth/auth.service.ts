import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export const STARTING_BALANCE = 10000n;
export const DEMO_CURRENCY = "DEMO";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Create an anonymous guest player with a funded play-money wallet. */
  async createGuest() {
    const id = randomUUID();
    const username = "Thief_" + id.slice(0, 8);

    const user = await this.prisma.user.create({
      data: {
        id,
        username,
        isGuest: true,
        wallets: { create: { currency: DEMO_CURRENCY, balance: STARTING_BALANCE } },
        profile: { create: { displayName: username } },
      },
      include: { wallets: true },
    });

    const wallet = user.wallets[0];
    const token = await this.jwt.signAsync({ sub: user.id, username });

    return {
      token,
      user: { id: user.id, username },
      wallet: { id: wallet.id, currency: wallet.currency, balance: Number(wallet.balance) },
    };
  }
}
