/**
 * Formats a numeric price value into Kwanzas (AOA) formatting.
 */
export function formatPrice(value: number): string {
  return new Intl.NumberFormat("pt-AO", {
    style: "currency",
    currency: "AOA",
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Capitalizes every word in a text string.
 */
export function capitalize(text: string): string {
  if (!text) return text;
  return text
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Delays execution for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formats a timestamp as `dd/mm/yyyy HH:mm` in Angola local time
 * (Africa/Luanda, UTC+1, no DST) — fixed to that zone rather than the
 * server's own TZ env so the output doesn't shift depending on where the
 * process happens to be deployed. Returns null for a null/invalid input so
 * callers can pass through nullable DB timestamp columns (e.g. registered_at)
 * unchanged.
 */
export function formatDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Luanda",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}
