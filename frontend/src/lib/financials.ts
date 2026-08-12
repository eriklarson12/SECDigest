/** Shared XBRL → chart-point transforms (AnalysisDashboard + the company page). */

import { formatDate } from "./format";
import type { AnnualFinancials, QuarterlyFinancials, TrendPoint } from "./types";

/** Does any year carry a figure the chart can't already show?
 *
 * Revenue and net income are the chart's job; MetricsTable earns its space only
 * when there is per-share, cash-flow or balance-sheet data to add. Shared so the
 * table's own guard and its two call sites can never disagree. */
export function hasAnnualMetrics(years: AnnualFinancials[]): boolean {
  return years.some(
    (y) =>
      y.eps_diluted != null ||
      y.operating_cash_flow != null ||
      y.cash != null ||
      y.total_assets != null ||
      y.stockholders_equity != null
  );
}

/** Exact XBRL annual figures → chart points; drops years with no usable data. */
export function buildAnnualPoints(years: AnnualFinancials[]): TrendPoint[] {
  return years
    .filter((y) => y.revenue !== null || y.net_income !== null)
    .map((y) => ({
      label: `FY${y.fiscal_year}`,
      revenue: y.revenue,
      netIncome: y.net_income,
    }));
}

/** Exact XBRL quarterly figures → chart points; drops quarters with no usable data. */
export function buildQuarterlyPoints(quarters: QuarterlyFinancials[]): TrendPoint[] {
  return quarters
    .filter((q) => q.revenue !== null || q.net_income !== null)
    .map((q) => ({
      label: formatDate(q.period_end),
      revenue: q.revenue,
      netIncome: q.net_income,
    }));
}
