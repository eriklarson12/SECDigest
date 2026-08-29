/** Cross-company ratios computed from the exact XBRL annual series
 * (GET /api/financials). Pure — no formatting, no fetching. Formatting stays in
 * lib/format.ts; the chart-point transforms stay in lib/financials.ts. */

import type { AnnualFinancials, FinancialsResponse, WatchItem } from "./types";

export type SortKey =
  | "ticker"
  | "fiscalYear"
  | "revenue"
  | "netMargin"
  | "ocfMargin"
  | "revenueCagr";

export type SortDir = "asc" | "desc";

export interface BenchmarkRow {
  item: WatchItem;
  state: "loading" | "ready" | "error";
  fiscalYear: number | null;
  revenue: number | null;
  netMargin: number | null;
  ocfMargin: number | null;
  revenueCagr: number | null;
}

function hasAnyFigure(y: AnnualFinancials): boolean {
  return (
    y.revenue != null ||
    y.net_income != null ||
    y.eps_diluted != null ||
    y.operating_cash_flow != null ||
    y.cash != null ||
    y.total_assets != null ||
    y.stockholders_equity != null
  );
}

/** The most recent fiscal year carrying any figure at all. The response order is
 * not assumed: a single year is picked here rather than a series charted, so a
 * reversed payload would silently pick the wrong one. */
export function latestYear(years: AnnualFinancials[]): AnnualFinancials | null {
  return years
    .filter(hasAnyFigure)
    .reduce<AnnualFinancials | null>(
      (best, y) => (best === null || y.fiscal_year > best.fiscal_year ? y : best),
      null,
    );
}

/** Revenue ≤ 0 yields null, not Infinity — a ratio over a non-positive
 * denominator is meaningless rather than large. */
function margin(numerator: number | null, revenue: number | null): number | null {
  if (numerator == null || revenue == null || revenue <= 0) return null;
  return (numerator / revenue) * 100;
}

export function netMargin(y: AnnualFinancials | null): number | null {
  return y ? margin(y.net_income, y.revenue) : null;
}

export function ocfMargin(y: AnnualFinancials | null): number | null {
  return y ? margin(y.operating_cash_flow, y.revenue) : null;
}

/** Compound annual revenue growth across exactly `span` years.
 *
 * The start year must be exactly `end - span` with a revenue of its own. A
 * shorter span is reported as null rather than substituted: the column header
 * says "3-yr", and a value computed over two years under that header is a wrong
 * number where a blank would have been an honest one. */
export function revenueCagr(years: AnnualFinancials[], span = 3): number | null {
  const withRevenue = years.filter((y) => y.revenue != null);
  const end = withRevenue.reduce<AnnualFinancials | null>(
    (best, y) => (best === null || y.fiscal_year > best.fiscal_year ? y : best),
    null,
  );
  if (!end) return null;

  const start = withRevenue.find((y) => y.fiscal_year === end.fiscal_year - span);
  if (!start || start.revenue == null || start.revenue <= 0) return null;
  if (end.revenue == null) return null;

  return ((end.revenue / start.revenue) ** (1 / span) - 1) * 100;
}

export function buildBenchmarkRow(
  item: WatchItem,
  data: FinancialsResponse,
): BenchmarkRow {
  const year = latestYear(data.years);
  return {
    item,
    state: "ready",
    fiscalYear: year?.fiscal_year ?? null,
    revenue: year?.revenue ?? null,
    netMargin: netMargin(year),
    ocfMargin: ocfMargin(year),
    revenueCagr: revenueCagr(data.years),
  };
}

/** Nulls sink in both directions — a company that tags no operating cash flow is
 * missing from that ranking, not last in it. Error rows carry only nulls and so
 * sink without a case of their own. */
export function sortBenchmarkRows(
  rows: BenchmarkRow[],
  key: SortKey,
  dir: SortDir,
): BenchmarkRow[] {
  const sign = dir === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (key === "ticker") {
      return sign * a.item.ticker.localeCompare(b.item.ticker);
    }
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return sign * (x - y);
  });
}
