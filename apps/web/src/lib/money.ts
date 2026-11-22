/** Formats integer cents as a pt-BR price (e.g. `5000` -> `"R$ 50,00"`). */
export function formatCentsBRL(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}
