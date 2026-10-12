import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CheckoutReturnPage } from "./CheckoutReturnPage";

function renderReturnPage(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/checkout/retorno${search}`]}>
      <Routes>
        <Route path="/checkout/retorno" element={<CheckoutReturnPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CheckoutReturnPage", () => {
  it("should show an approved message with links when Mercado Pago reports status=approved", async () => {
    // GIVEN Mercado Pago redirects back with an approved payment
    renderReturnPage("?status=approved&external_reference=booking-1");

    // WHEN the page renders
    // THEN it shows the approved message and links to the tickets/catalog pages
    expect(await screen.findByText("Pagamento aprovado!")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver meus ingressos" })).toHaveAttribute("href", "/tickets");
    expect(screen.getByRole("link", { name: "Voltar ao catálogo" })).toHaveAttribute("href", "/movies");
  });

  it("should show a pending message when Mercado Pago reports status=pending", async () => {
    // GIVEN Mercado Pago redirects back with a payment still being processed
    renderReturnPage("?status=pending&external_reference=booking-1");

    // WHEN the page renders
    // THEN it shows the pending message
    expect(await screen.findByText("Pagamento em análise")).toBeInTheDocument();
  });

  it("should show a rejected message when Mercado Pago reports status=rejected", async () => {
    // GIVEN Mercado Pago redirects back with a declined payment
    renderReturnPage("?status=rejected&external_reference=booking-1");

    // WHEN the page renders
    // THEN it shows the rejected message
    expect(await screen.findByText("Pagamento não aprovado")).toBeInTheDocument();
  });

  it("should show a generic message when the status is missing or unrecognized", async () => {
    // GIVEN the page is reached without a recognizable status query param
    renderReturnPage("");

    // WHEN the page renders
    // THEN it falls back to a generic "check back later" message instead of guessing an outcome
    expect(await screen.findByText("Retorno do pagamento")).toBeInTheDocument();
  });
});
