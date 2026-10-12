import { Link, useSearchParams } from "react-router-dom";

const STATUS_COPY: Record<string, { title: string; message: string }> = {
  approved: {
    title: "Pagamento aprovado!",
    message: "Seu ingresso foi confirmado. Você recebeu um e-mail com os detalhes da compra.",
  },
  pending: {
    title: "Pagamento em análise",
    message: "Assim que o Mercado Pago confirmar o pagamento, seu ingresso aparece em \"Meus ingressos\".",
  },
  rejected: {
    title: "Pagamento não aprovado",
    message: "O Mercado Pago recusou o pagamento. Você pode tentar novamente a partir do catálogo.",
  },
};

const DEFAULT_STATUS_COPY = {
  title: "Retorno do pagamento",
  message: "Assim que o Mercado Pago confirmar o status do pagamento, seu ingresso aparece em \"Meus ingressos\".",
};

export function CheckoutReturnPage() {
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const { title, message } = STATUS_COPY[status] ?? DEFAULT_STATUS_COPY;

  return (
    <main className="mx-auto max-w-md px-4 py-8 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-gray-600">{message}</p>
      <div className="mt-6 flex flex-col gap-2">
        <Link to="/tickets" className="text-sm underline">
          Ver meus ingressos
        </Link>
        <Link to="/movies" className="text-sm underline">
          Voltar ao catálogo
        </Link>
      </div>
    </main>
  );
}
