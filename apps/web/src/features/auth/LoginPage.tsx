import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { resolveReturnTo, returnToQuery } from "../../lib/return-to";
import type { ReleasedSeatsNoticeState } from "../seating/released-seats-state";
import { useAuth } from "./AuthContext";
import { isValidEmail } from "./validation";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const returnTo = resolveReturnTo(searchParams.get("returnTo"));
  const justRegistered = Boolean((location.state as { registered?: boolean } | null)?.registered);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const invalidEmail = email.length > 0 && !isValidEmail(email);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (invalidEmail) return;
    setError(null);
    setSubmitting(true);
    try {
      const transfer = await login(email, password);
      // Seats lost in the hand-over are reported on the seat page the user
      // returns to, so they can review the selection before paying.
      const state: ReleasedSeatsNoticeState | undefined = transfer?.releasedSeats.length
        ? { releasedSeats: transfer.releasedSeats }
        : undefined;
      navigate(returnTo, { state });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">movietickets</h1>
      {justRegistered && (
        <p className="text-sm text-green-700">Conta criada! Entra com seu e-mail e senha.</p>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-gray-600">E-mail</span>
          <input
            type="email"
            required
            pattern="[^\s@]+@[^\s@]+\.[^\s@]+"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        {invalidEmail && <p className="text-sm text-red-600">E-mail inválido</p>}
        <label className="flex flex-col gap-1">
          <span className="text-sm text-gray-600">Senha</span>
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || invalidEmail}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "Entrando…" : "Entrar"}
        </button>
      </form>
      <p className="text-center text-sm text-gray-600">
        Não tem conta?{" "}
        <Link to={`/register${returnToQuery(searchParams.get("returnTo"))}`} className="underline">
          Criar conta
        </Link>
      </p>
    </main>
  );
}
