import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefundBadge } from "./RefundBadge";

describe("RefundBadge (AC29)", () => {
  it.each([
    ["pending", "cancelled", "Ingresso cancelado. Estorno em andamento."],
    ["completed", "cancelled", "Ingresso cancelado e estornado."],
    ["pending", "expired", "Estorno em andamento"],
    ["failed", "cancelled", "Não foi possível estornar. Nossa equipe vai analisar."],
    ["failed", "confirmed", "Não foi possível estornar. Seu ingresso continua válido."],
  ] as const)("should render the %s refund badge for a %s booking", (status, bookingStatus, expected) => {
    // ARRANGE
    const refund = { status, amountCents: 5000 };

    // ACT
    render(<RefundBadge refund={refund} bookingStatus={bookingStatus} />);

    // ASSERT
    expect(screen.getByTestId("refund-badge")).toHaveTextContent(expected);
  });
});
