import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { JwtPayload } from "../auth/jwt-payload.type";
import { BusinessMetrics } from "../telemetry/business-metrics";

const SESSION_ROOM_PREFIX = "session";

export type SeatEventStatus = "held" | "released" | "booked";

export interface SeatUpdateEvent {
  seatId: string;
  status: SeatEventStatus;
  heldByUserId?: string;
}

/**
 * Dedicated WebSocket gateway for seat-map realtime updates, kept separate
 * from the REST API. CORS is left permissive (rather than reading
 * CORS_ORIGIN like main.ts does for the REST app) because gateway decorator
 * options evaluate at module-import time, before ConfigModule has loaded the
 * .env file — the JWT handshake check in handleConnection is the actual
 * access boundary here, not CORS.
 */
@WebSocketGateway({ namespace: "seating", cors: { origin: true } })
export class SeatingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SeatingGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly metrics: BusinessMetrics,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.metrics.wsConnectionRejected("missing_token");
      client.disconnect(true);
      return;
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      this.logger.warn(`Rejected WebSocket connection: invalid token (${client.id})`);
      this.metrics.wsConnectionRejected("invalid_token");
      client.disconnect(true);
      return;
    }

    // The client may have dropped while the token was being verified: then
    // handleDisconnect already ran (without userId) and must not be unbalanced.
    if (!client.connected) return;
    client.data.userId = payload.sub;
    this.metrics.wsConnectionOpened();
  }

  /** Only connections that passed the JWT handshake were counted, so only those are uncounted. */
  handleDisconnect(client: Socket): void {
    if (client.data?.userId === undefined) return;
    this.metrics.wsConnectionClosed();
  }

  /** Client joins the room for a session's seat map when opening it. */
  @SubscribeMessage("join")
  handleJoin(@MessageBody() sessionId: string, @ConnectedSocket() client: Socket): void {
    client.join(this.roomName(sessionId));
  }

  /** Client leaves the room when closing the seat map or navigating away. */
  @SubscribeMessage("leave")
  handleLeave(@MessageBody() sessionId: string, @ConnectedSocket() client: Socket): void {
    client.leave(this.roomName(sessionId));
  }

  /** Called by SeatingService/BookingService whenever a seat's state changes, to notify every other client viewing the same session. */
  broadcastSeatUpdate(sessionId: string, event: SeatUpdateEvent): void {
    this.server.to(this.roomName(sessionId)).emit("seat:update", event);
    this.metrics.seatBroadcast(event.status);
  }

  private roomName(sessionId: string): string {
    return `${SESSION_ROOM_PREFIX}:${sessionId}`;
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token as unknown;
    if (typeof authToken === "string" && authToken.length > 0) {
      return authToken;
    }
    const [type, token] = client.handshake.headers.authorization?.split(" ") ?? [];
    return type === "Bearer" ? token : undefined;
  }
}
