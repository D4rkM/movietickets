import { Navigate, Route, Routes } from "react-router-dom";
import { AdminCinemaFormPage } from "./features/admin/AdminCinemaFormPage";
import { AdminCinemasPage } from "./features/admin/AdminCinemasPage";
import { AdminHomePage } from "./features/admin/AdminHomePage";
import { AdminMovieFormPage } from "./features/admin/AdminMovieFormPage";
import { AdminMoviesPage } from "./features/admin/AdminMoviesPage";
import { AdminRoomFormPage } from "./features/admin/AdminRoomFormPage";
import { AdminRoomsPage } from "./features/admin/AdminRoomsPage";
import { AdminSessionFormPage } from "./features/admin/AdminSessionFormPage";
import { AdminSessionsPage } from "./features/admin/AdminSessionsPage";
import { AuthProvider } from "./features/auth/AuthContext";
import { LoginPage } from "./features/auth/LoginPage";
import { RegisterPage } from "./features/auth/RegisterPage";
import { CheckoutPage } from "./features/checkout/CheckoutPage";
import { CheckoutReturnPage } from "./features/checkout/CheckoutReturnPage";
import { MoviesPage } from "./features/catalog/MoviesPage";
import { SessionSeatsPage } from "./features/seating/SessionSeatsPage";
import { TicketsPage } from "./features/tickets/TicketsPage";
import { AdminRoute } from "./lib/AdminRoute";
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
        {/* Public: the catalog is the site's landing page, and a visitor picks
            seats under a guest identity. Login is only required to pay. */}
        <Route path="/movies" element={<MoviesPage />} />
        <Route path="/sessions/:id/seats" element={<SessionSeatsPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
        </Route>
        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<AdminHomePage />} />
          <Route path="/admin/movies" element={<AdminMoviesPage />} />
          <Route path="/admin/movies/new" element={<AdminMovieFormPage />} />
          <Route path="/admin/movies/:id" element={<AdminMovieFormPage />} />
          <Route path="/admin/cinemas" element={<AdminCinemasPage />} />
          <Route path="/admin/cinemas/new" element={<AdminCinemaFormPage />} />
          <Route path="/admin/cinemas/:id" element={<AdminCinemaFormPage />} />
          <Route path="/admin/rooms" element={<AdminRoomsPage />} />
          <Route path="/admin/rooms/new" element={<AdminRoomFormPage />} />
          <Route path="/admin/rooms/:id" element={<AdminRoomFormPage />} />
          <Route path="/admin/sessions" element={<AdminSessionsPage />} />
          <Route path="/admin/sessions/new" element={<AdminSessionFormPage />} />
          <Route path="/admin/sessions/:id" element={<AdminSessionFormPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export default App;
