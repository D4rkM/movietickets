import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "./AuthContext";
import { ProfileMenu } from "./ProfileMenu";

const SAMPLE_USER = { id: "user-1", name: "Ana Souza", email: "ana@test.com", role: "customer" };

function renderProfileMenu() {
  return render(
    <MemoryRouter initialEntries={["/movies"]}>
      <AuthProvider>
        <Routes>
          <Route path="/movies" element={<ProfileMenu />} />
          <Route path="/tickets" element={<p>Tickets page</p>} />
          <Route path="/login" element={<p>Login page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("ProfileMenu (integration)", () => {
  beforeEach(() => {
    localStorage.setItem("movietickets:accessToken", "token-123");
    localStorage.setItem("movietickets:user", JSON.stringify(SAMPLE_USER));
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("should show the user's name and open a dropdown with ticket/logout options on click", async () => {
    // GIVEN a logged-in user
    renderProfileMenu();

    // WHEN the user clicks the profile button
    await userEvent.click(screen.getByRole("button", { name: /Ana Souza/ }));

    // THEN it shows the menu options
    expect(screen.getByRole("link", { name: "Ver ingressos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sair" })).toBeInTheDocument();
  });

  it("should navigate to /tickets when 'Ver ingressos' is clicked", async () => {
    // GIVEN the menu is open
    renderProfileMenu();
    await userEvent.click(screen.getByRole("button", { name: /Ana Souza/ }));

    // WHEN the user clicks "Ver ingressos"
    await userEvent.click(screen.getByRole("link", { name: "Ver ingressos" }));

    // THEN it navigates to the tickets page
    expect(await screen.findByText("Tickets page")).toBeInTheDocument();
  });

  it("should log out and navigate to /login when 'Sair' is clicked", async () => {
    // GIVEN the menu is open
    renderProfileMenu();
    await userEvent.click(screen.getByRole("button", { name: /Ana Souza/ }));

    // WHEN the user clicks "Sair"
    await userEvent.click(screen.getByRole("button", { name: "Sair" }));

    // THEN it clears the session and navigates to the login page
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(localStorage.getItem("movietickets:accessToken")).toBeNull();
  });
});
