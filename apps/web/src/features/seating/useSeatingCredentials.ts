import { useCallback, useEffect, useState } from "react";
import { clearGuestToken, ensureGuestToken, readTokenSubject, readValidGuestToken } from "../../lib/guest-token";
import { useAuth } from "../auth/AuthContext";

export type SeatingCredentials =
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | {
      status: "ready";
      /** Bearer token for the seat map, hold/release calls and the WebSocket handshake. */
      token: string;
      /** Hold owner id as the API stores it: the user id, or `guest:<uuid>` for a visitor. */
      ownerId: string;
      isGuest: boolean;
      /** Drops a guest token the API rejected, so a fresh one is requested. */
      invalidateGuest: () => void;
    };

/**
 * Picks the identity the seat page acts under: the logged-in user's token when
 * there is one, otherwise a guest token (reused from storage while valid, or
 * requested from `POST /auth/guest`). Nothing seat-related should be loaded
 * until this is `ready`.
 */
export function useSeatingCredentials(): SeatingCredentials {
  const { accessToken, user } = useAuth();
  const isUser = Boolean(accessToken && user);
  const [guestToken, setGuestToken] = useState<string | null>(() => (isUser ? null : readValidGuestToken()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isUser || guestToken || error) return;
    let cancelled = false;

    ensureGuestToken()
      .then((token) => {
        if (!cancelled) setGuestToken(token);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
    // Clearing `error` (retry) re-runs this effect and asks for a token again.
  }, [isUser, guestToken, error]);

  const retry = useCallback(() => setError(null), []);

  const invalidateGuest = useCallback(() => {
    clearGuestToken();
    setGuestToken(null);
  }, []);

  if (isUser && accessToken && user) {
    return { status: "ready", token: accessToken, ownerId: user.id, isGuest: false, invalidateGuest };
  }
  if (error) {
    return { status: "error", message: error, retry };
  }
  if (guestToken) {
    return {
      status: "ready",
      token: guestToken,
      ownerId: readTokenSubject(guestToken) ?? "",
      isGuest: true,
      invalidateGuest,
    };
  }
  return { status: "loading" };
}
