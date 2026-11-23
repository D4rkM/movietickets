import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { UnauthorizedError } from "../../lib/api-client";
import { formatCentsBRL } from "../../lib/money";
import { useAuth } from "../auth/AuthContext";
import { AdminLayout } from "./AdminLayout";
import { listRefundReviewQueue, requestAdminRefund } from "./api";
import { formatSaoPauloDateTime } from "./format";
import { isRefundReconcile, refundStatusLabel, reviewReasonLabel } from "./refund-labels";
import type { RefundReviewItem } from "./types";

export function AdminRefundsPage() {
  const { accessToken, logout } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<RefundReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const handleUnauthorized = useCallback(() => {
    logout();
    navigate("/login");
  }, [logout, navigate]);

  const loadQueue = useCallback(
    (isCancelled: () => boolean = () => false): Promise<void> => {
      if (!accessToken) return Promise.resolve();
      return listRefundReviewQueue(accessToken)
        .then((data) => {
          if (!isCancelled()) setQueue(data);
        })
        .catch((err: unknown) => {
          if (isCancelled()) return;
          if (err instanceof UnauthorizedError) {
            handleUnauthorized();
            return;
          }
          setError(err instanceof Error ? err.message : "Falha ao carregar a fila de estornos");
        });
    },
    [accessToken, handleUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    void loadQueue(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadQueue]);

  async function handleRefund(item: RefundReviewItem) {
    if (!accessToken) return;
    const reconcile = isRefundReconcile(item);
    if (!reconcile && !window.confirm(`Estornar ${formatCentsBRL(item.amountCents)} para ${item.customerEmail}?`)) {
      return;
    }

    setError(null);
    setNotice(null);
    setSubmittingId(item.bookingId);
    try {
      const result = await requestAdminRefund(item.bookingId, accessToken);
      setNotice(`Estorno de ${item.customerEmail}: ${refundStatusLabel(result.refund?.status)}.`);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : "Falha ao solicitar o estorno");
    } finally {
      setSubmittingId(null);
    }
    await loadQueue();
  }

  return (
    <AdminLayout title="Estornos">
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-green-700">
          {notice}
        </p>
      )}

      {!queue && !error && <p>Carregando fila de estornos…</p>}
      {queue?.length === 0 && <p>Nenhuma reserva aguardando estorno.</p>}

      {queue && queue.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-600">
                <th className="py-2 pr-4 font-medium">Filme</th>
                <th className="py-2 pr-4 font-medium">Sessão (São Paulo)</th>
                <th className="py-2 pr-4 font-medium">Cliente</th>
                <th className="py-2 pr-4 font-medium">Valor</th>
                <th className="py-2 pr-4 font-medium">Motivo</th>
                <th className="py-2 pr-4 font-medium">Último estorno</th>
                <th className="py-2 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.bookingId} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{item.movieTitle}</td>
                  <td className="py-2 pr-4">{formatSaoPauloDateTime(item.sessionStartsAt)}</td>
                  <td className="py-2 pr-4">{item.customerEmail}</td>
                  <td className="py-2 pr-4">{formatCentsBRL(item.amountCents)}</td>
                  <td className="py-2 pr-4">{reviewReasonLabel(item.reviewReason)}</td>
                  <td className="py-2 pr-4">{refundStatusLabel(item.refund?.status)}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => void handleRefund(item)}
                      disabled={submittingId !== null}
                      className="text-indigo-600 hover:underline disabled:opacity-50"
                    >
                      {isRefundReconcile(item) ? "Atualizar status" : "Estornar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminLayout>
  );
}
