import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./features/auth/AuthContext";
import { LoginPage } from "./features/auth/LoginPage";
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
