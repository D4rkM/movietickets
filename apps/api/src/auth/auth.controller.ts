import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /** Public: issues a guest identity so a visitor can hold seats before logging in. */
  @Post("guest")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  issueGuestToken() {
    return this.authService.issueGuestToken();
  }
}
