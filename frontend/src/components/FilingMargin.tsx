import { formatCurrency, formatPercent } from "@/lib/format";
import { filingNetMargin } from "@/lib/ratios";
import type { AnalysisResponse } from "@/lib/types";
import SectionHeader from "./SectionHeader";

/** What the two headline figures say together and neither says alone: how much of this
 * filing's revenue reached the bottom line (roadmap 16.17). It replaced a bar chart that
 * redrew the same two figures.
 *
 * The figure is text and the bar is `aria-hidden`, so nothing is carried by width or colour.
 * A loss has no share to draw: the bar stays empty and the sentence says "net loss". */
export default function FilingMargin({ analysis }: { analysis: AnalysisResponse }) {
  const margin = filingNetMargin(analysis);
  if (margin === null) return null;

  const netIncome = analysis.net_income_current ?? 0;
  const loss = netIncome < 0;

  return (
    <div className="print:break-inside-avoid">
      <SectionHeader title="This filing" caption="Net income as a share of revenue" />
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-4xl tabular-nums leading-none text-text">
          {formatPercent(margin)}
        </span>
        <span className="text-sm text-muted">
          net margin: {loss ? "a net loss" : "net income"} of{" "}
          {formatCurrency(Math.abs(netIncome))} on revenue of{" "}
          {formatCurrency(analysis.revenue_current)}
        </span>
      </p>
      <div aria-hidden className="mt-3 h-1.5 w-full bg-surface-2">
        <div
          data-testid="margin-bar"
          className="h-full bg-accent"
          style={{ width: `${Math.min(100, Math.max(0, margin))}%` }}
        />
      </div>
    </div>
  );
}
