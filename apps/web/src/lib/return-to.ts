export const DEFAULT_RETURN_TO = "/movies";

// Never a real origin: only used as the base to resolve `returnTo` against, so
// anything that escapes it (protocol-relative, absolute URL, scheme) shows up
// as a different origin.
const FIXED_ORIGIN = "http://app.invalid";

// Encoded slash/backslash: a later decode could turn `/%2F` into `//`.
const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * Accepts only an internal path starting with a single `/` (e.g.
 * `/sessions/1/seats`); anything else falls back to `/movies`, so `/login`
 * can never be used as an open redirect.
 */
export function resolveReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }
  if (ENCODED_SEPARATOR.test(value)) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const url = new URL(value, FIXED_ORIGIN);
    if (url.origin !== FIXED_ORIGIN) return DEFAULT_RETURN_TO;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}
