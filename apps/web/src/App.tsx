import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./features/auth/AuthContext";
import { LoginPage } from "./features/auth/LoginPage";
import { RegisterPage } from "./features/auth/RegisterPage";
import { CheckoutPage } from "./features/checkout/CheckoutPage";
import { CheckoutReturnPage } from "./features/checkout/CheckoutReturnPage";
import { MoviesPage } from "./features/catalog/MoviesPage";
import { SessionSeatsPage } from "./features/seating/SessionSeatsPage";
import { TicketsPage } from "./features/tickets/TicketsPage";
import { ProtectedRoute } from "./lib/ProtectedRoute";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/movies" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* Public: Mercado Pago's back_urls redirect lands here as a plain browser
            navigation, which may arrive on a different origin/session than the one
            the user checked out from (cross-domain redirect, session expired while
            on MP's site). The page only reads its own status query param and shows
            a static message — no auth needed, and the booking itself was already
            confirmed server-to-server by the webhook regardless of this page. */}
        <Route path="/checkout/retorno" element={<CheckoutReturnPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/movies" element={<MoviesPage />} />
          <Route path="/sessions/:id/seats" element={<SessionSeatsPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export default App;
