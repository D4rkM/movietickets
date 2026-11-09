import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { GUEST_TOKEN_STORAGE_KEY } from "./lib/guest-token";

describe("App routing", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("AC32: não deve renderizar a página de retorno removida em /checkout/retorno", () => {
    // GIVEN the Checkout Pro return route was removed
    localStorage.clear();

    // WHEN the user navigates to /checkout/retorno
    render(
      <MemoryRouter initialEntries={["/checkout/retorno?status=approved"]}>
        <App />
      </MemoryRouter>,
    );

    // THEN the legacy return page heading is not rendered
    expect(screen.queryByText("Pagamento aprovado!")).not.toBeInTheDocument();
    expect(screen.queryByText("Retorno do pagamento")).not.toBeInTheDocument();
  });

  it("AC1: should show the catalog to a visitor without a token, with no redirect to login", async () => {
    // ARRANGE — no access token stored, catalog API answers with one movie
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: "movie-1", title: "Dune", synopsis: null, durationMinutes: 155, posterUrl: null, rating: null, sessions: [] },
        ],
      } as Response),
    );

    // ACT
    render(
      <MemoryRouter initialEntries={["/movies"]}>
        <App />
      </MemoryRouter>,
    );

    // ASSERT
    expect(await screen.findByText("Dune")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Em cartaz" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Entrar" })).not.toBeInTheDocument();
  });

  it.each(["/checkout", "/tickets"])(
    "AC8: should redirect %s to login without a user token, even with a guest token stored",
    async (path) => {
      // ARRANGE
      localStorage.setItem(
        GUEST_TOKEN_STORAGE_KEY,
        JSON.stringify({ guestToken: "guest-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      );

      // ACT
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );

      // ASSERT
      expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
    },
  );
});
