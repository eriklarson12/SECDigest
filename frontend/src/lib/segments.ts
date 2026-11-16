import { formatDate } from "./format";
import type { SegmentRevenue, SegmentRow } from "./types";

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

/** "Other Countries", "All Other", "Rest of World": what is left once the named members are
 * taken out. Matched on the label, which is what the reader sees. */
const RESIDUAL = /^(all )?other|^rest of|not separately disclosed/i;

/** The rows a reader is shown. The backend sorts by value, which puts a residual bucket first
 * whenever it is the largest (AAPL's "Other Countries" at 47.8%); a residual says nothing until
 * the named rows have been read, so it goes after them. A zero row is dropped: it exists for
 * the backend's 1% reconciliation and tells a reader nothing. */
export function displayRows(rows: SegmentRow[]): SegmentRow[] {
  const shown = rows.filter((row) => row.value !== 0);
  return [
    ...shown.filter((row) => !RESIDUAL.test(row.label)),
    ...shown.filter((row) => RESIDUAL.test(row.label)),
  ];
}
