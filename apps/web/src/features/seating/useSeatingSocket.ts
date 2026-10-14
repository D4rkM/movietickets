import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { API_URL } from "../../lib/api-client";
import type { SeatState } from "./types";

export type SeatEventStatus = "held" | "released" | "booked";

export interface SeatUpdateEvent {
  seatId: string;
  status: SeatEventStatus;
  heldByUserId?: string;
}

export function toSeatState(event: SeatUpdateEvent, userId: string): SeatState {
  if (event.status === "booked") return "booked";
  if (event.status === "released") return "free";
  return event.heldByUserId === userId ? "held_by_me" : "held_by_other";
}

/**
 * Keeps a session's seat map live: joins the SeatingGateway's room for
 * `sessionId` on mount, forwards every `seat:update` broadcast to `onUpdate`,
 * and leaves the room on unmount. Deliberately does not refetch the whole
 * seat map on each event — only the affected seat needs updating.
 */
export function useSeatingSocket(
  sessionId: string,
  accessToken: string,
  onUpdate: (event: SeatUpdateEvent) => void,
): void {
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    // extraHeaders only reaches the initial polling handshake (browsers don't
    // let WebSocket set custom headers), but that's enough — ngrok's free-tier
    // interstitial would otherwise reject the handshake before it can upgrade.
    const socket = io(`${API_URL}/seating`, {
      auth: { token: accessToken },
      extraHeaders: { "ngrok-skip-browser-warning": "true" },
    });

    socket.on("connect", () => {
      socket.emit("join", sessionId);
    });
    socket.on("seat:update", (event: SeatUpdateEvent) => {
      onUpdateRef.current(event);
    });

    return () => {
      socket.emit("leave", sessionId);
      socket.disconnect();
    };
  }, [sessionId, accessToken]);
}
