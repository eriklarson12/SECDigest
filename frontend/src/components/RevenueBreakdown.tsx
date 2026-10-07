import { formatCurrency, formatPercent } from "@/lib/format";
import { periodLabel, shareOf } from "@/lib/segments";
import type { RevenueSplit, SegmentRevenue } from "@/lib/types";
import SectionHeader from "./SectionHeader";

interface RevenueBreakdownProps {
  revenue: SegmentRevenue;
  formType: string;
}

/** Where the revenue comes from, by reportable segment and by geography (roadmap 12.8).
 *
 * Tables, not a chart: a categorical palette for N segments would be a third data colour, which
 * `docs/design-system.md` does not allow. The caller renders this only when a split exists, and
 * every split it receives already adds up to its total. */
export default function RevenueBreakdown({ revenue, formType }: RevenueBreakdownProps) {
  return (
    <section aria-label="Revenue breakdown">
      <SectionHeader
        title="Where the revenue comes from"
        subtitle={`${periodLabel(revenue, formType)} · as tagged in the filing's XBRL`}
      />
      <div className="mt-3 grid gap-6 md:grid-cols-2">
        {revenue.segments && <SplitTable heading="Segment" split={revenue.segments} />}
        {revenue.geography && <SplitTable heading="Geography" split={revenue.geography} />}
      </div>
    </section>
  );
}

const CELL = "py-1.5 pl-4";

function SplitTable({ heading, split }: { heading: string; split: RevenueSplit }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-sans text-xs">
        <caption className="sr-only">Revenue by {heading.toLowerCase()}</caption>
        <thead>
          <tr className="border-b border-border text-right text-2xs uppercase tracking-[0.06em] text-muted">
            <th scope="col" className="py-1.5 pr-4 text-left">
              {heading}
            </th>
            <th scope="col" className={CELL}>
              Revenue
            </th>
            <th scope="col" className={CELL}>
              Share
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {split.rows.map((row) => (
            <tr key={row.member} className="border-b border-border text-right text-text">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {row.label}
              </th>
              <td className={CELL}>{formatCurrency(row.value)}</td>
              <td className={CELL}>{formatPercent(shareOf(row.value, split.total))}</td>
            </tr>
          ))}
          {split.reconciling.map((row) => (
            <tr key={row.member} className="border-b border-border text-right text-muted">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {row.label}
              </th>
              <td className={CELL}>{formatCurrency(row.value)}</td>
              <td className={CELL}>{formatPercent(shareOf(row.value, split.total))}</td>
            </tr>
          ))}
          <tr className="border-t border-text text-right font-semibold text-text">
            <th scope="row" className="py-1.5 pr-4 text-left">
              Total
            </th>
            <td className={CELL}>{formatCurrency(split.total)}</td>
            <td className={CELL} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
