import { io, Socket as ClientSocket } from "socket.io-client";
import { AdminModule } from "../../src/admin/admin.module";
import { GuestFlowApp, startGuestFlowApp } from "./guest-flow-app";
import { MercadoPagoMocks } from "./pending-booking";
import { TestTelemetry } from "./telemetry";

/**
 * The full app (auth, seating, booking, payment, refund, admin) with
 * BusinessMetrics recording into the test's in-memory MeterProvider.
 * Mercado Pago stays stubbed, as in every other integration test.
 */
export function startAppWithBusinessMetrics(telemetry: TestTelemetry): Promise<GuestFlowApp> {
  return startGuestFlowApp({ extraImports: [AdminModule], meterProvider: telemetry.meterProvider });
}

let nextMercadoPagoPaymentId = 7_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000);

/** Makes `Payment.create` answer synchronously with the given status. */
export function mercadoPagoAnswersPayment(mocks: MercadoPagoMocks, status: string, statusDetail = "accredited"): void {
  mocks.payment.create.mockResolvedValue({
    id: nextMercadoPagoPaymentId++,
    status,
    status_detail: statusDetail,
    installments: 1,
    payment_method_id: "visa",
  });
}

export interface SeatingConnection {
  /** True when the gateway kept the socket open after the handshake. */
  accepted: boolean;
  close: () => Promise<void>;
}

/**
 * Opens a `/seating` socket with the given token (or none) and resolves once
 * the gateway either kept it (connected for a moment) or dropped it.
 */
export async function connectToSeating(baseUrl: string, token?: string, settleMs = 150): Promise<SeatingConnection> {
  const socket: ClientSocket = io(`${baseUrl}/seating`, {
    auth: token ? { token } : {},
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise<void>((resolve) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const accepted = socket.connected;
  return {
    accepted,
    close: async () => {
      socket.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

/**
 * Attribute keys each `movietickets.*` metric may carry (the closed table of
 * docs/flows/observability/spec.md, "Métricas"). Anything else is a leak.
 */
export const ALLOWED_BUSINESS_METRIC_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "movietickets.seat_hold.created": ["holder.kind"],
  "movietickets.seat_hold.rejected": ["reason"],
  "movietickets.seat_hold.released": ["reason"],
  "movietickets.seat_hold.transferred": [],
  "movietickets.booking.created": [],
  "movietickets.booking.seats": [],
  "movietickets.booking.confirmed": ["confirmation.source"],
  "movietickets.booking.expired": ["expiry.trigger"],
  "movietickets.booking.cancelled": [],
  "movietickets.booking.refund_review_flagged": [],
  "movietickets.payment.attempt.created": [],
  "movietickets.payment.status_changed": ["payment.status", "payment.source"],
  "movietickets.payment.provider.errors": ["error.type"],
  "movietickets.payment.stale_alert": [],
  "movietickets.sweeper.runs": ["outcome"],
  "movietickets.sweeper.duration": ["outcome"],
  "movietickets.seating.ws.connections": [],
  "movietickets.seating.ws.rejected": ["reason"],
  "movietickets.seating.broadcasts": ["seat.status"],
  "movietickets.notification.email": ["outcome"],
  "movietickets.refund.requested": [],
  "movietickets.refund.status_changed": ["refund.status"],
};

/** `metric: key` for every recorded attribute key outside the allowlist (or unknown metric). */
export async function unexpectedMetricAttributes(telemetry: TestTelemetry): Promise<string[]> {
  const unexpected: string[] = [];
  for (const [metric, points] of await telemetry.allMetrics()) {
    if (!metric.startsWith("movietickets.")) continue;
    const allowed = ALLOWED_BUSINESS_METRIC_ATTRIBUTES[metric];
    if (!allowed) {
      unexpected.push(`${metric}: (not in the spec table)`);
      continue;
    }
    for (const point of points) {
      for (const key of Object.keys(point.attributes)) {
        if (!allowed.includes(key)) unexpected.push(`${metric}: ${key}`);
      }
    }
  }
  return unexpected;
}

/** Every attribute value recorded on any `movietickets.*` metric, as one string (to search for leaked ids). */
export async function recordedBusinessAttributeValues(telemetry: TestTelemetry): Promise<string> {
  const values: unknown[] = [];
  for (const [metric, points] of await telemetry.allMetrics()) {
    if (!metric.startsWith("movietickets.")) continue;
    for (const point of points) values.push(...Object.values(point.attributes));
  }
  return JSON.stringify(values);
}
