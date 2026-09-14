import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../features/auth/AuthContext";
import { ACCESS_TOKEN_STORAGE_KEY } from "./api-client";
import { ProtectedRoute } from "./ProtectedRoute";

function renderProtectedRoute() {
  return render(
    <MemoryRouter initialEntries={["/private"]}>
      <AuthProvider>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/private" element={<p>Private content</p>} />
          </Route>
          <Route path="/login" element={<p>Login page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("should redirect to /login when there is no access token", async () => {
    // ARRANGE — no token in storage

    // ACT
    renderProtectedRoute();

    // ASSERT
    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(screen.queryByText("Private content")).not.toBeInTheDocument();
  });

  it("should render the nested route when an access token is present", async () => {
    // ARRANGE
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, "token-123");

    // ACT
    renderProtectedRoute();

    // ASSERT
    expect(await screen.findByText("Private content")).toBeInTheDocument();
    expect(screen.queryByText("Login page")).not.toBeInTheDocument();
  });
});
