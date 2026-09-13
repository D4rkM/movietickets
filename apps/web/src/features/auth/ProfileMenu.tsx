import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function ProfileMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  function handleLogout() {
    setOpen(false);
    logout();
    navigate("/login");
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-900 text-xs font-medium text-white">
          {user.name.charAt(0).toUpperCase()}
        </span>
        {user.name}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Fechar menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-2 w-44 rounded border border-gray-200 bg-white py-1 shadow-lg">
            <Link
              to="/tickets"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm hover:bg-gray-50"
            >
              Ver ingressos
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-50"
            >
              Sair
            </button>
          </div>
        </>
      )}
    </div>
  );
}
