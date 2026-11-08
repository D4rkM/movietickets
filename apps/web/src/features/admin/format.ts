export const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

const saoPauloPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SAO_PAULO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function extractPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/**
 * Converts a `datetime-local` value (`YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss`)
 * interpreted in `America/Sao_Paulo` into an ISO 8601 UTC string (`...Z`),
 * regardless of the browser/process local timezone.
 */
export function saoPauloDateTimeLocalToIso(dateTimeLocal: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    dateTimeLocal.trim(),
  );
  if (!match) {
    return "";
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");

  const targetWallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(targetWallAsUtc)) {
    return "";
  }

  // Probe the America/Sao_Paulo wall-clock parts at `targetWallAsUtc` to compute
  // the exact offset of America/Sao_Paulo at that instant without relying on the
  // runtime's local timezone.
  const parts = saoPauloPartsFormatter.formatToParts(new Date(targetWallAsUtc));
  const zonedWallAsUtc = Date.UTC(
    Number(extractPart(parts, "year")),
    Number(extractPart(parts, "month")) - 1,
    Number(extractPart(parts, "day")),
    Number(extractPart(parts, "hour")),
    Number(extractPart(parts, "minute")),
    Number(extractPart(parts, "second")),
  );

  const offsetMs = targetWallAsUtc - zonedWallAsUtc;
  return new Date(targetWallAsUtc + offsetMs).toISOString();
}

/**
 * Formats an ISO 8601 timestamp into a `YYYY-MM-DDTHH:mm` value for `<input type="datetime-local">`
 * in the `America/Sao_Paulo` timezone, regardless of the browser/process local timezone.
 */
export function isoToSaoPauloDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = saoPauloPartsFormatter.formatToParts(date);
  const year = extractPart(parts, "year");
  const month = extractPart(parts, "month");
  const day = extractPart(parts, "day");
  const hour = extractPart(parts, "hour");
  const minute = extractPart(parts, "minute");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Formats an ISO 8601 timestamp for human display (`DD/MM/YYYY HH:mm`) in `America/Sao_Paulo`.
 */
export function formatSaoPauloDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = saoPauloPartsFormatter.formatToParts(date);
  const year = extractPart(parts, "year");
  const month = extractPart(parts, "month");
  const day = extractPart(parts, "day");
  const hour = extractPart(parts, "hour");
  const minute = extractPart(parts, "minute");
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

/**
 * Converts a price typed in reais (e.g. `"35"`, `"35.50"`, `"35,50"`) into integer cents.
 * Returns `NaN` when the input is empty or not a valid decimal currency amount.
 */
export function reaisToCents(input: string | number): number {
  const normalized = String(input).trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return Number.NaN;
  }
  return Math.round(Number(normalized) * 100);
}

/** Formats integer cents as a decimal string for a currency input (e.g. `3500` -> `"35.00"`). */
export function centsToReaisInput(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

/** Formats integer cents as a display price in BRL (e.g. `3500` -> `"R$ 35.00"`). */
export function formatPriceReais(priceCents: number): string {
  return `R$ ${(priceCents / 100).toFixed(2)}`;
}
