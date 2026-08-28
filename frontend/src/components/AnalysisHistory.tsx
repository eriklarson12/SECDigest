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
    <div className="overflow-x-auto">
      <table className="w-full text-left font-sans text-xs">
        <thead>
          <tr className="border-b border-text text-2xs uppercase tracking-[0.06em] text-muted">
            <th className="py-1.5 pr-4 font-normal">Company</th>
            <th className="py-1.5 pr-4 font-normal">Type</th>
            <th className="whitespace-nowrap py-1.5 pr-4 font-normal">Filed</th>
            <th className="py-1.5 pl-4 text-right font-normal">Revenue</th>
            <th className="py-1.5 pl-4 text-right font-normal">Net income</th>
            <th className="whitespace-nowrap py-1.5 pl-4 text-right font-normal">
              Analyzed
            </th>
          </tr>
        </thead>
        <tbody>
          {analyses.map((a) => (
            <tr
              key={a.id}
              className="group/row border-b border-border transition-colors duration-150 hover:bg-surface-2"
            >
              <td className="py-1.5 pr-4">
                <Link
                  href={`/analysis/${a.id}`}
                  className="font-serif text-sm text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {a.ticker}
                </Link>
                <span className="ml-2 text-muted">{a.company_name}</span>
                <Link
                  href={`/company/${a.ticker}`}
                  className="ml-2 text-3xs text-muted opacity-0 transition-opacity duration-150 hover:text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover/row:opacity-100"
                >
                  company →
                </Link>
              </td>
              <td className="py-1.5 pr-4">
                <FormBadge formType={a.form_type} />
              </td>
              <td className="whitespace-nowrap py-1.5 pr-4 tabular-nums text-muted">
                {formatDate(a.filing_date)}
              </td>
              <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-text">
                {formatCurrency(a.revenue_current)}
              </td>
              <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-text">
                {formatCurrency(a.net_income_current)}
              </td>
              <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-muted">
                {formatDate(a.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
