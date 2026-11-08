import { JwtService } from "@nestjs/jwt";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { io, Socket as ClientSocket } from "socket.io-client";
import { holdKey } from "../../src/seating/hold-keys";

type SeatState = "free" | "held_by_other" | "held_by_me" | "booked";

let nextFakeIp = 1;

/** A distinct client IP per call, so suites don't trip the per-IP rate limit on POST /auth/guest by accident. */
function uniqueClientIp(): string {
  const n = nextFakeIp++;
  return `10.${(process.pid >> 8) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export interface GuestIdentity {
  guestToken: string;
  expiresAt: string;
  /** `guest:<uuid>`: the value stored as the hold owner. */
  holderId: string;
}

export async function requestGuestToken(app: NestFastifyApplication, clientIp = uniqueClientIp()) {
  return app.inject({ method: "POST", url: "/auth/guest", remoteAddress: clientIp });
}

export async function obtainGuestIdentity(app: NestFastifyApplication, jwtService: JwtService): Promise<GuestIdentity> {
  const response = await requestGuestToken(app);
  if (response.statusCode !== 200) {
    throw new Error(`POST /auth/guest failed with ${response.statusCode}: ${response.body}`);
  }
  const { guestToken, expiresAt } = response.json();
  const { sub } = jwtService.decode<{ sub: string }>(guestToken);
  return { guestToken, expiresAt, holderId: sub };
}

export function holdSeatAs(app: NestFastifyApplication, token: string, sessionId: string, seatId: string) {
  return app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/seats/${seatId}/hold`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Holds every seat in order, failing loudly if any hold is refused. */
export async function holdSeatsAs(
  app: NestFastifyApplication,
  token: string,
  sessionId: string,
  seatIds: string[],
): Promise<void> {
  for (const seatId of seatIds) {
    const response = await holdSeatAs(app, token, sessionId, seatId);
    if (response.statusCode !== 200) {
      throw new Error(`Hold of ${seatId} failed with ${response.statusCode}: ${response.body}`);
    }
  }
}

export function releaseSeatAs(app: NestFastifyApplication, token: string, sessionId: string, seatId: string) {
  return app.inject({
    method: "DELETE",
    url: `/sessions/${sessionId}/seats/${seatId}/hold`,
    headers: { authorization: `Bearer ${token}` },
  });
}

export function releaseAllHoldsAs(app: NestFastifyApplication, token: string, sessionId: string) {
  return app.inject({
    method: "DELETE",
    url: `/sessions/${sessionId}/holds`,
    headers: { authorization: `Bearer ${token}` },
  });
}

export function readSeatMapAs(app: NestFastifyApplication, token: string, sessionId: string) {
  return app.inject({
    method: "GET",
    url: `/sessions/${sessionId}/seats`,
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function seatStatusSeenBy(
  app: NestFastifyApplication,
  token: string,
  sessionId: string,
  seatId: string,
): Promise<SeatState | undefined> {
  const response = await readSeatMapAs(app, token, sessionId);
  return response.json().seats.find((seat: { id: string }) => seat.id === seatId)?.status;
}

export function loginWith(
  app: NestFastifyApplication,
  credentials: { email: string; password: string; guestToken?: string },
) {
  return app.inject({ method: "POST", url: "/auth/login", payload: credentials });
}

export function callAs(
  app: NestFastifyApplication,
  token: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

export function holdOwner(valkey: Redis, sessionId: string, seatId: string): Promise<string | null> {
  return valkey.get(holdKey(sessionId, seatId));
}

export async function holdOwners(valkey: Redis, sessionId: string, seatIds: string[]): Promise<(string | null)[]> {
  return Promise.all(seatIds.map((seatId) => holdOwner(valkey, sessionId, seatId)));
}

export function holdRemainingMs(valkey: Redis, sessionId: string, seatId: string): Promise<number> {
  return valkey.pttl(holdKey(sessionId, seatId));
}

/** Forces a hold's remaining TTL, to make "older"/"newer" holds deterministic. */
export async function ageHold(valkey: Redis, sessionId: string, seatId: string, remainingMs: number): Promise<void> {
  await valkey.pexpire(holdKey(sessionId, seatId), remainingMs);
}

/** Makes a hold run out on its own, as if its 10min TTL had elapsed. */
export async function expireHoldNow(valkey: Redis, sessionId: string, seatId: string): Promise<void> {
  await valkey.pexpire(holdKey(sessionId, seatId), 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
}

export async function clearSessionHolds(valkey: Redis, sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    const keys = await valkey.keys(`seat-hold:${sessionId}:*`);
    if (keys.length > 0) await valkey.del(...keys);
  }
}

/** Signs a guest token directly, for scenarios the public endpoint can't produce (e.g. already expired). */
export function signGuestToken(jwtService: JwtService, holderId: string, expiresInSeconds: number): string {
  return jwtService.sign({ kind: "guest", sub: holderId }, { expiresIn: expiresInSeconds });
}

export interface SeatUpdate {
  seatId: string;
  status: string;
  heldByUserId?: string;
}

export interface SeatingWatcher {
  socket: ClientSocket;
  /** Every seat:update received so far. */
  updates: SeatUpdate[];
  /** Resolves once an update matching the predicate has arrived (or already had). */
  waitFor: (predicate: (update: SeatUpdate) => boolean, timeoutMs?: number) => Promise<SeatUpdate>;
  close: () => void;
}

/** Connects to the seating gateway with the given token and joins the session room. */
export async function watchSessionAs(baseUrl: string, token: string, sessionId: string): Promise<SeatingWatcher> {
  const socket = await new Promise<ClientSocket>((resolve, reject) => {
    const client = io(`${baseUrl}/seating`, { auth: { token }, transports: ["websocket"], reconnection: false });
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });

  const updates: SeatUpdate[] = [];
  socket.on("seat:update", (update: SeatUpdate) => updates.push(update));
  socket.emit("join", sessionId);
  // Give the server a moment to process the join before the test acts.
  await new Promise((resolve) => setTimeout(resolve, 80));

  const waitFor = (predicate: (update: SeatUpdate) => boolean, timeoutMs = 2000) =>
    new Promise<SeatUpdate>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const match = updates.find(predicate);
        if (match) return resolve(match);
        if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for seat:update"));
        setTimeout(poll, 20);
      };
      poll();
    });

  return { socket, updates, waitFor, close: () => socket.disconnect() };
}

/** True when the socket is still connected a short while after the handshake (the gateway didn't kick it). */
export async function staysConnected(socket: ClientSocket, waitMs = 200): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return socket.connected;
}
