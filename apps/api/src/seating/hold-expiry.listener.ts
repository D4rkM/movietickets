import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { SeatingGateway } from "./seating.gateway";
import { HOLD_KEY_PREFIX } from "./seating.service";

const EXPIRED_EVENT_PATTERN = "__keyevent@*__:expired";

export interface ParsedHoldKey {
  sessionId: string;
  seatId: string;
}

/** Parses a `seat-hold:{sessionId}:{seatId}` key; undefined for any other key. */
export function parseHoldKey(key: string): ParsedHoldKey | undefined {
  if (!key.startsWith(`${HOLD_KEY_PREFIX}:`)) return undefined;
  const [, sessionId, seatId] = key.split(":");
  if (!sessionId || !seatId) return undefined;
  return { sessionId, seatId };
}

/**
 * Valkey only reports a key's expiry passively — nothing calls the app back
 * when a seat hold's TTL runs out on its own (user abandoned the tab without
 * cancelling). Subscribing to keyspace notifications is what turns that into
 * a seat:update broadcast for every other client watching the session,
 * instead of them only finding out on their next manual refetch.
 */
@Injectable()
export class HoldExpiryListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HoldExpiryListener.name);
  private subscriber?: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly gateway: SeatingGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.getOrThrow<string>("VALKEY_URL");

    // Turning on keyspace notifications is a one-off config write, done on a
    // throwaway connection: once a client enters subscribe mode below it can
    // no longer run any other command on that same connection.
    const configClient = new Redis(connectionString);
    await configClient.config("SET", "notify-keyspace-events", "Ex");
    await configClient.quit();

    this.subscriber = new Redis(connectionString);
    await this.subscriber.psubscribe(EXPIRED_EVENT_PATTERN);
    this.subscriber.on("pmessage", (_pattern: string, _channel: string, key: string) => {
      this.handleExpiredKey(key);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit();
  }

  private handleExpiredKey(key: string): void {
    const parsed = parseHoldKey(key);
    if (!parsed) return;

    this.logger.debug(`Hold expired passively: session=${parsed.sessionId} seat=${parsed.seatId}`);
    this.gateway.broadcastSeatUpdate(parsed.sessionId, { seatId: parsed.seatId, status: "released" });
  }
}
