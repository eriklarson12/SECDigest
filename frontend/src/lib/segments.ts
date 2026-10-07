import { formatDate } from "./format";
import type { SegmentRevenue } from "./types";

/** Revenue by segment and geography (roadmap 12.8). The backend only sends splits that add up,
 * so nothing here re-checks a sum. */

export function hasBreakdown(
  revenue: SegmentRevenue | null | undefined,
): revenue is SegmentRevenue {
  return Boolean(revenue && (revenue.segments || revenue.geography));
}

/** A 10-Q's breakdown is its quarter, not the year to date the filing's own period tag names. */
export function periodLabel(revenue: SegmentRevenue, formType: string): string {
  const end = formatDate(revenue.period_end);
  return formType.startsWith("10-Q") ? `Three months ended ${end}` : `Fiscal year ended ${end}`;
}

/** A row's share of the split's total, as a percent. Reconciling rows can be negative. */
export function shareOf(value: number, total: number): number | null {
  return total === 0 ? null : (value / total) * 100;
}
