import { Controller, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";

@Controller("api/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Create a guest session and return a JWT + funded play-money wallet. */
  @Post("guest")
  guest() {
    return this.auth.createGuest();
  }
}
