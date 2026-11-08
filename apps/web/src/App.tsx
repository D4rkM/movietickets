import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./features/auth/AuthContext";
import { LoginPage } from "./features/auth/LoginPage";
import { RegisterPage } from "./features/auth/RegisterPage";
import { CheckoutPage } from "./features/checkout/CheckoutPage";
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
        {/* Public: the catalog is the site's landing page, and a visitor picks
            seats under a guest identity. Login is only required to pay. */}
        <Route path="/movies" element={<MoviesPage />} />
        <Route path="/sessions/:id/seats" element={<SessionSeatsPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export default App;
