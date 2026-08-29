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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Past a month a relative unit stops informing — "58 days ago" is harder to
 * place than the date itself. */
const RELATIVE_LIMIT_MS = 30 * DAY_MS;

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** How long ago an instant was, as a phrase: "just now", "3 hours ago",
 * "yesterday", or "on Jul 4, 2026" once it's older than a month. The `on`
 * belongs to the phrase, not the call site — the two branches have to read
 * the same way in one sentence. `now` is a parameter so tests need no timers. */
export function formatRelativeTime(
  value: string | null,
  now: number = Date.now(),
): string {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return value;

  // A clock behind the server's puts this in the future; "just now" is the
  // honest reading of a negative elapsed, not a bug worth surfacing.
  const elapsed = now - then;
  if (elapsed >= RELATIVE_LIMIT_MS) return `on ${formatDate(value)}`;
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS)
    return RELATIVE.format(-Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS)
    return RELATIVE.format(-Math.floor(elapsed / HOUR_MS), "hour");
  return RELATIVE.format(-Math.floor(elapsed / DAY_MS), "day");
}
