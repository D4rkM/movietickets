import type { Page } from "@playwright/test";
import { E2E_API_URL } from "./api";

// Refunds go through Mercado Pago's Refunds API, which e2e can't drive: the
// real checkout charge is never made (payments are confirmed through the mock
// confirm route, see mercadopago.ts), so no booking in the e2e database has an
// approved payment to refund. These helpers stub only the refund-related API
// responses, with the exact shapes the backend returns, so the refund UI runs
// in a real browser against a real login.

const HOUR_MS = 60 * 60 * 1000;

type RefundStatus = "pending" | "completed" | "failed";

export interface MockTicket {
  bookingId: string;
  status: string;
  session: {
    id: string;
    startsAt: string;
    priceCents: number;
    movie: { title: string };
    room: { name: string };
    cinema: { name: string; city: string };
  };
  seats: Array<{ rowLabel: string; seatNumber: number }>;
  amountCents: number;
  cancellableUntil: string;
  refund: { status: RefundStatus; amountCents: number; requestedAt: string } | null;
}

/** A `GET /bookings/mine` item for a session `hoursAhead` from now (deadline = start minus 2h). */
export function mockTicket(options: {
  movieTitle: string;
  hoursAhead?: number;
  status?: string;
  refundStatus?: RefundStatus;
  amountCents?: number;
}): MockTicket {
  const startsAt = Date.now() + (options.hoursAhead ?? 48) * HOUR_MS;
  const amountCents = options.amountCents ?? 5000;
  return {
    bookingId: `e2e-booking-${options.movieTitle.toLowerCase().replace(/\W+/g, "-")}`,
    status: options.status ?? "confirmed",
    session: {
      id: "e2e-session",
      startsAt: new Date(startsAt).toISOString(),
      priceCents: amountCents,
      movie: { title: options.movieTitle },
      room: { name: "Sala E2E" },
      cinema: { name: "Cine E2E", city: "Recife" },
    },
    seats: [{ rowLabel: "A", seatNumber: 1 }],
    amountCents,
    cancellableUntil: new Date(startsAt - 2 * HOUR_MS).toISOString(),
    refund: options.refundStatus
      ? { status: options.refundStatus, amountCents, requestedAt: new Date().toISOString() }
      : null,
  };
}

/** Serves `GET /bookings/mine` with the given tickets (a function is re-read on every load). */
export async function stubMyTickets(page: Page, tickets: MockTicket[] | (() => MockTicket[])): Promise<void> {
  await page.route(`${E2E_API_URL}/bookings/mine`, (route) =>
    route.fulfill({ status: 200, json: typeof tickets === "function" ? tickets() : tickets }),
  );
}

export interface StubbedResponse {
  status: number;
  body: unknown;
}

/**
 * Answers each `POST /bookings/:id/cancel` with the next queued response and
 * returns the list of booking ids the page tried to cancel.
 */
export async function stubCancelResponses(page: Page, responses: StubbedResponse[]): Promise<string[]> {
  const calls: string[] = [];
  await page.route(`${E2E_API_URL}/bookings/*/cancel`, (route) => {
    calls.push(new URL(route.request().url()).pathname.split("/")[2]);
    const next = responses.shift() ?? { status: 500, body: { message: "unexpected extra cancel call" } };
    return route.fulfill({ status: next.status, json: next.body });
  });
  return calls;
}

export function cancelledWithRefund(ticket: MockTicket, refundStatus: RefundStatus): StubbedResponse {
  return {
    status: 200,
    body: {
      bookingId: ticket.bookingId,
      status: "cancelled",
      refund: { id: "e2e-refund", status: refundStatus, amountCents: ticket.amountCents },
    },
  };
}

export function apiError(status: number, code: string, message: string): StubbedResponse {
  return { status, body: { statusCode: status, code, message } };
}

type ReviewReason = "expired_booking_paid" | "refund_rejected" | "refund_stalled";
type AdminRefundStatus = "requested" | "in_process" | "approved" | "rejected" | "failed";

export interface MockReviewItem {
  bookingId: string;
  bookingStatus: string;
  customerEmail: string;
  movieTitle: string;
  sessionStartsAt: string;
  amountCents: number;
  externalPaymentId: string | null;
  paymentApprovedAt: string | null;
  reviewReason: ReviewReason;
  refund: { id: string; status: AdminRefundStatus; errorCode: string | null; updatedAt: string } | null;
}

/** A `GET /admin/refunds/review` item. */
export function mockReviewItem(options: {
  customerEmail: string;
  reviewReason: ReviewReason;
  refundStatus?: AdminRefundStatus;
  amountCents?: number;
}): MockReviewItem {
  const now = new Date().toISOString();
  return {
    bookingId: `e2e-review-${options.customerEmail.replace(/\W+/g, "-")}`,
    bookingStatus: options.reviewReason === "refund_rejected" ? "cancelled" : "expired",
    customerEmail: options.customerEmail,
    movieTitle: "Filme E2E",
    sessionStartsAt: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    amountCents: options.amountCents ?? 5000,
    externalPaymentId: "e2e-mp-payment",
    paymentApprovedAt: now,
    reviewReason: options.reviewReason,
    refund: options.refundStatus
      ? { id: "e2e-refund", status: options.refundStatus, errorCode: null, updatedAt: now }
      : null,
  };
}

export interface ReviewQueueStub {
  /** Current queue; tests mutate it through the refund handler. */
  queue: MockReviewItem[];
  /** Booking ids the page asked to refund. */
  refundCalls: string[];
  /** Number of times the page loaded the queue. */
  loads: number;
}

/**
 * Serves `GET /admin/refunds/review` from an in-memory queue and answers
 * `POST /admin/bookings/:id/refund` with `respond` (default: approved, and the
 * booking leaves the queue).
 */
export async function stubRefundReviewQueue(
  page: Page,
  queue: MockReviewItem[],
  respond?: (item: MockReviewItem) => StubbedResponse,
): Promise<ReviewQueueStub> {
  const stub: ReviewQueueStub = { queue: [...queue], refundCalls: [], loads: 0 };
  await page.route(`${E2E_API_URL}/admin/refunds/review`, (route) => {
    stub.loads += 1;
    return route.fulfill({ status: 200, json: stub.queue });
  });
  await page.route(`${E2E_API_URL}/admin/bookings/*/refund`, (route) => {
    const bookingId = new URL(route.request().url()).pathname.split("/")[3];
    stub.refundCalls.push(bookingId);
    const item = stub.queue.find((candidate) => candidate.bookingId === bookingId)!;
    const response = respond
      ? respond(item)
      : {
          status: 200,
          body: {
            bookingId,
            bookingStatus: item.bookingStatus,
            refund: { id: "e2e-refund", status: "approved", amountCents: item.amountCents },
          },
        };
    if (response.status === 200) {
      stub.queue = stub.queue.filter((candidate) => candidate.bookingId !== bookingId);
    }
    return route.fulfill({ status: response.status, json: response.body });
  });
  return stub;
}

export async function openAdminRefunds(page: Page): Promise<void> {
  await page.goto("/admin/refunds");
}

/** The queue row (`<tr>`) of the given customer. */
export function reviewRow(page: Page, customerEmail: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: customerEmail, exact: true }) });
}
