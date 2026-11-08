const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

// drizzle-orm wraps the driver's PostgresError in a DrizzleQueryError, so the
// Postgres error code lives on `.cause` rather than on the error itself.
function hasPostgresCode(err: unknown, code: string): boolean {
  if (hasCode(err, code)) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return hasCode(cause, code);
}

export function isUniqueViolation(err: unknown): boolean {
  return hasPostgresCode(err, UNIQUE_VIOLATION);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return hasPostgresCode(err, FOREIGN_KEY_VIOLATION);
}
