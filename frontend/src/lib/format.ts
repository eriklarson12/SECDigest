/** The only home for figure formatting (frontend/CLAUDE.md). */

export function formatCurrency(value: number | null): string {
  if (value === null) return "N/A";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${value.toLocaleString()}`;
}

/** Compact variant for chart axes/tooltips. */
export function formatCurrencyCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toLocaleString()}`;
}

/** Per-share figures keep exact cents — no compact suffixes. */
export function formatEps(value: number | null): string {
  if (value === null) return "—";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "N/A";
  return `${value.toFixed(1)}%`;
}

/** A bare YYYY-MM-DD parses as UTC midnight and then renders in local time, which
 * is the previous day west of UTC. Appending a wall-clock time parses it as local
 * midnight instead, so the calendar date survives. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar dates (filing_date, period_end) keep their own day everywhere; full
 * timestamps (created_at) are real instants and render in the viewer's zone. */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
