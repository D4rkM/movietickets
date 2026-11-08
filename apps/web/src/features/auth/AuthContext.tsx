import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ACCESS_TOKEN_STORAGE_KEY, USER_STORAGE_KEY } from "../../lib/api-client";
import { clearGuestToken, readValidGuestToken } from "../../lib/guest-token";
import { login as loginRequest } from "./api";
import type { AuthUser, HoldTransfer } from "./types";

interface AuthContextValue {
  accessToken: string | null;
  user: AuthUser | null;
  /** Resolves with the hold transfer report when a guest token was handed over. */
  login: (email: string, password: string) => Promise<HoldTransfer | undefined>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(() =>
    localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY),
  );
  const [user, setUser] = useState<AuthUser | null>(readStoredUser);

  const login = useCallback(async (email: string, password: string) => {
    const {
      accessToken: token,
      user: loggedInUser,
      transfer,
    } = await loginRequest(email, password, readValidGuestToken());
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(loggedInUser));
    // The guest identity is done once the user is in: its holds were either
    // transferred (token now consumed server-side) or are no longer reachable.
    clearGuestToken();
    setAccessToken(token);
    setUser(loggedInUser);
    return transfer;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ accessToken, user, login, logout }),
    [accessToken, user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
