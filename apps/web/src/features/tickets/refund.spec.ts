import { describe, expect, it } from "vitest";
import { canCancelTicket, inactiveTicketLabel, isCancellationClosed, isTicketInactive, refundBadgeText } from "./refund";
import type { Ticket, TicketRefund } from "./types";

const NOW = new Date("2026-11-20T12:00:00.000Z");

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    bookingId: "b-1",
    status: "confirmed",
    session: {
      id: "s-1",
      startsAt: "2026-11-20T20:00:00.000Z",
      priceCents: 2500,
      movie: { title: "Dune" },
      room: { name: "Sala 1" },
      cinema: { name: "Cine A", city: "Recife" },
    },
    seats: [{ rowLabel: "A", seatNumber: 1 }],
    amountCents: 2500,
    cancellableUntil: "2026-11-20T18:00:00.000Z",
    refund: null,
    ...overrides,
  };
}

const failedRefund: TicketRefund = { status: "failed", amountCents: 2500 };
const pendingRefund: TicketRefund = { status: "pending", amountCents: 2500 };

describe("canCancelTicket", () => {
  it.each([
    ["confirmed before the deadline", ticket(), true],
    ["confirmed with a failed refund (customer may retry)", ticket({ refund: failedRefund }), true],
    ["confirmed with a refund still pending", ticket({ refund: pendingRefund }), false],
    ["confirmed exactly at the deadline", ticket({ cancellableUntil: NOW.toISOString() }), false],
    ["confirmed after the deadline", ticket({ cancellableUntil: "2026-11-20T11:00:00.000Z" }), false],
    ["cancelled", ticket({ status: "cancelled", refund: pendingRefund }), false],
    ["expired", ticket({ status: "expired", refund: pendingRefund }), false],
  ])("should decide for a ticket %s", (_case, input, expected) => {
    // ARRANGE
    const now = NOW;

    // ACT
    const result = canCancelTicket(input, now);

    // ASSERT
    expect(result).toBe(expected);
  });
});

describe("isCancellationClosed", () => {
  it.each([
    ["confirmed before the deadline", ticket(), false],
    ["confirmed after the deadline", ticket({ cancellableUntil: "2026-11-20T11:00:00.000Z" }), true],
    ["cancelled after the deadline", ticket({ status: "cancelled", cancellableUntil: "2026-11-20T11:00:00.000Z" }), false],
  ])("should decide for a ticket %s", (_case, input, expected) => {
    // ARRANGE
    const now = NOW;

    // ACT
    const result = isCancellationClosed(input, now);

    // ASSERT
    expect(result).toBe(expected);
  });
});

describe("refundBadgeText", () => {
  it.each([
    ["pending", "cancelled", "Ingresso cancelado. Estorno em andamento."],
    ["completed", "cancelled", "Ingresso cancelado e estornado."],
    ["pending", "expired", "Estorno em andamento"],
    ["completed", "expired", "Estorno concluído"],
    ["failed", "cancelled", "Não foi possível estornar. Nossa equipe vai analisar."],
    ["failed", "expired", "Não foi possível estornar. Nossa equipe vai analisar."],
    ["failed", "confirmed", "Não foi possível estornar. Seu ingresso continua válido."],
  ] as const)("should describe a %s refund on a %s booking", (refundStatus, bookingStatus, expected) => {
    // ARRANGE
    const status = refundStatus;

    // ACT
    const text = refundBadgeText(status, bookingStatus);

    // ASSERT
    expect(text).toBe(expected);
  });
});

describe("inactiveTicketLabel", () => {
  it.each([
    ["cancelled", "Cancelado"],
    ["expired", "Expirado"],
    ["confirmed", null],
  ])("should label a %s booking", (status, expected) => {
    // ARRANGE
    const bookingStatus = status;

    // ACT
    const label = inactiveTicketLabel(bookingStatus);

    // ASSERT
    expect(label).toBe(expected);
  });
});

describe("isTicketInactive", () => {
  it.each([
    ["cancelled", true],
    ["expired", true],
    ["confirmed", false],
  ])("should decide for a %s booking", (status, expected) => {
    // ARRANGE
    const bookingStatus = status;

    // ACT
    const result = isTicketInactive(bookingStatus);

    // ASSERT
    expect(result).toBe(expected);
  });
});
