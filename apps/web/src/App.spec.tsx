import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

describe("App routing", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("should show the Mercado Pago return page without requiring a logged-in session", async () => {
    // GIVEN no access token stored — e.g. Mercado Pago's back_urls redirect landed
    // on a different origin/session than the one the user checked out from
    localStorage.clear();

    // WHEN the user lands on the checkout return route
    render(
      <MemoryRouter initialEntries={["/checkout/retorno?status=approved"]}>
        <App />
      </MemoryRouter>,
    );

    // THEN it shows the return page instead of redirecting to login
    expect(await screen.findByText("Pagamento aprovado!")).toBeInTheDocument();
  });

  it("should redirect to login when visiting a protected route without a token", async () => {
    // GIVEN no access token stored
    localStorage.clear();

    // WHEN the user tries to reach a protected route directly
    render(
      <MemoryRouter initialEntries={["/movies"]}>
        <App />
      </MemoryRouter>,
    );

    // THEN it redirects to the login page instead
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });
});
