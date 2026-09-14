import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { register } from "./api";
import { isValidEmail } from "./validation";

export function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const invalidEmail = email.length > 0 && !isValidEmail(email);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (passwordsMismatch || invalidEmail) return;
    setError(null);
    setSubmitting(true);
    try {
      await register(name, email, password);
      navigate("/login", { state: { registered: true } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Criar conta</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-gray-600">Nome</span>
          <input
            type="text"
            required
            minLength={2}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
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
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-gray-600">Confirmar senha</span>
          <input
            type="password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="rounded border border-gray-300 px-3 py-2"
          />
        </label>
        {passwordsMismatch && <p className="text-sm text-red-600">Senhas não coincidem</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || passwordsMismatch || invalidEmail}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "Criando…" : "Criar conta"}
        </button>
      </form>
      <p className="text-center text-sm text-gray-600">
        Já tem conta?{" "}
        <Link to="/login" className="underline">
          Entrar
        </Link>
      </p>
    </main>
  );
}
