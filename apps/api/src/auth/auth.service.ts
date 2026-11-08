import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DRIZZLE } from "../db/drizzle.module";
import * as schema from "../db/schema";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { HoldTransferResult, HoldTransferService } from "../seating/hold-transfer.service";
import { GUEST_TOKEN_TTL_SECONDS } from "./guest-token.constants";
import {
  GUEST_SUBJECT_PREFIX,
  GuestJwtPayload,
  guestIdFromSubject,
  JwtPayload,
  UserJwtPayload,
} from "./jwt-payload.type";

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly jwtService: JwtService,
    private readonly holdTransferService: HoldTransferService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email),
    });
    if (existing) {
      throw new ConflictException("Email já cadastrado");
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const [user] = await this.db
      .insert(schema.users)
      .values({ name: dto.name, email: dto.email, passwordHash })
      .returning();

    // Register only creates the account — no token here. Callers must log in
    // separately to obtain an access token.
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  }

  async login(dto: LoginDto) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email),
    });
    if (!user) {
      throw new UnauthorizedException("Credenciais inválidas");
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException("Credenciais inválidas");
    }

    // Only reached after the password check: a failed login never moves holds.
    const transfer = dto.guestToken ? await this.transferGuestHolds(dto.guestToken, user.id) : undefined;

    return { ...this.buildAuthResponse(user), ...(transfer ? { transfer } : {}) };
  }

  issueGuestToken(): { guestToken: string; expiresAt: string } {
    const payload: GuestJwtPayload = { kind: "guest", sub: `${GUEST_SUBJECT_PREFIX}${randomUUID()}` };
    const guestToken = this.jwtService.sign(payload, { expiresIn: GUEST_TOKEN_TTL_SECONDS });
    const { exp } = this.jwtService.decode<{ exp: number }>(guestToken);
    return { guestToken, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /**
   * An unusable guest token (invalid, expired, user-kind, or already consumed)
   * never blocks the login: the transfer is just skipped and `transfer` is
   * left out of the response.
   */
  private async transferGuestHolds(guestToken: string, userId: string): Promise<HoldTransferResult | undefined> {
    let payload: JwtPayload & { exp?: number };
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload & { exp?: number }>(guestToken);
    } catch {
      return undefined;
    }

    const guestId = payload.kind === "guest" ? guestIdFromSubject(payload.sub) : undefined;
    if (!guestId || payload.exp === undefined) {
      return undefined;
    }
    return this.holdTransferService.transferGuestHolds(guestId, userId, payload.exp);
  }

  private buildAuthResponse(user: schema.User) {
    const payload: UserJwtPayload = { kind: "user", sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: this.jwtService.sign(payload),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }
}
