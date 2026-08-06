import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { AnalysisResponse } from "@/lib/types";
import { formatDate } from "@/lib/format";
import InsightCard from "./InsightCard";
import RiskFactors from "./RiskFactors";
import FormBadge from "./FormBadge";

interface CompareColumnProps {
  analysis: AnalysisResponse;
}

/** One company's latest analysis, stacked for side-by-side comparison. */
export default function CompareColumn({ analysis }: CompareColumnProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-2xl font-bold text-text">{analysis.ticker}</h2>
          <FormBadge formType={analysis.form_type} />
        </div>
        <p className="mt-1 text-sm text-muted">{analysis.company_name}</p>
        {analysis.filing_date && (
          <p className="font-mono text-xs tabular-nums text-muted">
            Filed {formatDate(analysis.filing_date)}
          </p>
        )}
        <Link
          href={`/analysis/${analysis.id}`}
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 transition-colors duration-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          View full analysis
          <ArrowRight className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        </Link>
      </div>

      <InsightCard
        label="Revenue"
        value={analysis.revenue_current}
        changePercent={analysis.revenue_yoy_change_pct}
      />
      <InsightCard
        label="Net Income"
        value={analysis.net_income_current}
        changePercent={analysis.net_income_yoy_change_pct}
      />

      {analysis.summary && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Summary
          </h3>
          <p className="text-sm leading-relaxed text-text">{analysis.summary}</p>
        </div>
      )}

      <RiskFactors risks={analysis.risk_factors} />
    </div>
  );
}
