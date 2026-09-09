"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSectorCounts, listAnalyses } from "@/lib/api";
import type { AnalysisListResponse, SectorCount } from "@/lib/types";
import {
  compareSectors,
  formatCurrency,
  formatDate,
  formatRelativeTime,
  formatSector,
  UNCLASSIFIED_SECTOR,
} from "@/lib/format";
import FormBadge from "./FormBadge";
import Delta from "./Delta";
import SectionHeader from "./SectionHeader";

/** Cached analyses surface on the homepage — best-effort, hidden on error
 * or while empty so a fresh instance still leads with the hero.
 *
 * Renders last on the homepage, and must: it appears only once its fetch
 * resolves, so anything below it would be displaced. A reserved skeleton was
 * the obvious alternative and is worse — it collapses when the corpus is empty
 * or the API is down, which is a shift of its own, and the Lighthouse job
 * measures with no backend, so that is the case it would fail on. */
export default function RecentAnalyses() {
  // The response carries `total` for the whole table, not just this page —
  // the corpus caption is free with the rows.
  const [corpus, setCorpus] = useState<AnalysisListResponse>({
    analyses: [],
    total: 0,
  });
  const [sectors, setSectors] = useState<SectorCount[]>([]);

  // One await, not two effects: the section renders nothing until its fetch resolves,
  // and two independent resolutions would commit it twice. The sectors call is caught
  // inside the `all` so a failing aggregate costs the line, never the rows.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listAnalyses(6, 0), getSectorCounts().catch(() => null)])
      .then(([rows, counts]) => {
        if (cancelled) return;
        setCorpus(rows);
        if (counts) setSectors(counts.sectors);
      })
      .catch(() => {
        // decorative section — stay hidden on failure
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { analyses, total } = corpus;
  if (analyses.length === 0) return null;

  const ordered = [...sectors].sort((a, b) =>
    compareSectors(a.owner_org, b.owner_org),
  );

  return (
    <section className="mt-12 w-full" aria-label="Recently analyzed filings">
      <SectionHeader as="h2" title="Recently analyzed" />
      <div>
        {analyses.map((a) => (
          <Link
            key={a.id}
            href={`/analysis/${a.id}`}
            className="grid grid-cols-[4rem_minmax(0,1fr)_auto_auto] items-baseline gap-x-3 border-b border-border py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:grid-cols-[4rem_minmax(0,1fr)_3.5rem_6rem_4rem_5rem]"
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
            {/* Wrapper holds the grid cell even when the delta is null —
                otherwise the filing date slides into this column. */}
            <span className="text-right text-2xs">
              <Delta value={a.revenue_yoy_change_pct} />
            </span>
            <span className="hidden text-right font-sans text-2xs tabular-nums text-muted sm:block">
              {formatDate(a.filing_date)}
            </span>
          </Link>
        ))}
      </div>
      {/* Rows are ordered created_at desc by the API, so the newest is first. */}
      <p className="mt-0.5 font-sans text-2xs tabular-nums text-muted">
        {`${total.toLocaleString()} ${total === 1 ? "filing" : "filings"} analyzed · newest ${formatRelativeTime(analyses[0].created_at)}`}
      </p>
      {/* The corpus by SEC review office — six rows cannot be grouped into ~12 buckets,
          so the sectors count the whole table while the rows above stay newest-first.
          Inline links in a caption, following the history page's own Clear control:
          a row of chips would wrap badly at 375px with the longest office names. */}
      {ordered.length > 0 && (
        <p
          className="mt-1 font-sans text-2xs text-muted"
          data-testid="sector-counts"
        >
          {ordered.map((sector, i) => (
            <span key={sector.owner_org ?? UNCLASSIFIED_SECTOR}>
              {i > 0 && <span aria-hidden> · </span>}
              <Link
                href={`/history?owner_org=${encodeURIComponent(sector.owner_org ?? UNCLASSIFIED_SECTOR)}`}
                className="underline transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {formatSector(sector.owner_org)}
              </Link>
              {/* Non-breaking, so a wrap cannot separate a count from its office. */}
              {"\u00a0"}
              <span className="tabular-nums">{sector.count}</span>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
