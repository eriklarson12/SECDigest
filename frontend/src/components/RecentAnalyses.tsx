"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listAnalyses } from "@/lib/api";
import type { AnalysisResponse } from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/format";
import FormBadge from "./FormBadge";

/** Cached analyses surface on the homepage — best-effort, hidden on error
 * or while empty so a fresh instance still leads with the hero. */
export default function RecentAnalyses() {
  const [analyses, setAnalyses] = useState<AnalysisResponse[]>([]);

  useEffect(() => {
    let cancelled = false;
    listAnalyses(6, 0)
      .then((res) => {
        if (!cancelled) setAnalyses(res.analyses);
      })
      .catch(() => {
        // decorative section — stay hidden on failure
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (analyses.length === 0) return null;

  return (
    <section
      className="mt-14 w-full max-w-4xl animate-fade-in-up"
      aria-label="Recently analyzed filings"
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
        Recently Analyzed
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {analyses.map((a) => (
          <Link
            key={a.id}
            href={`/analysis/${a.id}`}
            className="rounded-xl border border-border bg-surface p-4 transition-colors duration-200 hover:border-primary/50 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-text">
                {a.ticker}
              </span>
              <FormBadge formType={a.form_type} />
            </div>
            <p className="mt-1 truncate text-xs text-muted">{a.company_name}</p>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="font-mono text-sm font-semibold tabular-nums text-text">
                {formatCurrency(a.revenue_current)}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted">
                {formatDate(a.filing_date)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
