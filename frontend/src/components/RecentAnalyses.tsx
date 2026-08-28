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
    <section className="mt-12 w-full" aria-label="Recently analyzed filings">
      <h2 className="border-b border-text pb-1.5 font-sans text-[10px] uppercase tracking-[0.1em] text-muted">
        Recently analyzed
      </h2>
      <div>
        {analyses.map((a) => (
          <Link
            key={a.id}
            href={`/analysis/${a.id}`}
            className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-border py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:grid-cols-[4rem_minmax(0,1fr)_3.5rem_6rem_5rem]"
          >
            <span className="text-text">{a.ticker}</span>
            <span className="truncate text-sm text-muted">
              {a.company_name}
            </span>
            <span className="hidden sm:block">
              <FormBadge formType={a.form_type} />
            </span>
            <span className="text-right font-sans text-xs tabular-nums text-text">
              {formatCurrency(a.revenue_current)}
            </span>
            <span className="hidden text-right font-sans text-[11px] tabular-nums text-muted sm:block">
              {formatDate(a.filing_date)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
