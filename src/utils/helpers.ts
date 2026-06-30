/**
 * Formats a numeric price value into Kwanzas (AOA) formatting.
 */
export function formatarPreco(valor: number): string {
  return new Intl.NumberFormat("pt-AO", {
    style: "currency",
    currency: "AOA",
    maximumFractionDigits: 0,
  }).format(valor);
}

/**
 * Capitalizes every word in a text string.
 */
export function capitalizar(texto: string): string {
  if (!texto) return texto;
  return texto
    .toLowerCase()
    .split(" ")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * Delays execution for a given number of milliseconds.
 */
export function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
