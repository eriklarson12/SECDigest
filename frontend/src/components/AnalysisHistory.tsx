"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import type { AnalysisResponse } from "@/lib/types";
import EmptyState from "./EmptyState";
import FormBadge from "./FormBadge";

interface AnalysisHistoryProps {
  analyses: AnalysisResponse[];
  filter?: string;
  onClearFilter?: () => void;
}

export default function AnalysisHistory({
  analyses,
  filter,
  onClearFilter,
}: AnalysisHistoryProps) {
  if (analyses.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No analyses yet"
        message={
          filter
            ? `No analyses for ${filter}`
            : "Search a ticker and analyze a filing to start building your history."
        }
        action={
          filter && onClearFilter
            ? { label: "Clear filter", onClick: onClearFilter }
            : { href: "/", label: "Search a ticker" }
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th className="px-4 py-3 font-medium">Company</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Filing Date</th>
            <th className="px-4 py-3 text-right font-medium">Revenue</th>
            <th className="px-4 py-3 text-right font-medium">Net Income</th>
            <th className="px-4 py-3 font-medium">Analyzed</th>
          </tr>
        </thead>
        <tbody>
          {analyses.map((a) => (
            <tr
              key={a.id}
              className="border-b border-border/50 transition-colors duration-150 last:border-b-0 hover:bg-surface-2"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/analysis/${a.id}`}
                  className="font-mono font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {a.ticker}
                </Link>
                <span className="ml-2 text-muted">{a.company_name}</span>
              </td>
              <td className="px-4 py-3">
                <FormBadge formType={a.form_type} />
              </td>
              <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted">
                {formatDate(a.filing_date)}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-text">
                {formatCurrency(a.revenue_current)}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-text">
                {formatCurrency(a.net_income_current)}
              </td>
              <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted">
                {formatDate(a.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
