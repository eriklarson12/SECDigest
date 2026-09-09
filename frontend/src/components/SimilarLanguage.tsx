"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Waypoints } from "lucide-react";

import { getSimilarFilings } from "@/lib/api";
import { useIndexStatus } from "@/lib/useIndexStatus";
import {
  benchmarkHref,
  poolCaption,
  similarState,
  type SimilarState,
} from "@/lib/similar";
import FormBadge from "./FormBadge";
import SectionHeader from "./SectionHeader";

interface SimilarLanguageProps {
  analysisId: number;
  ticker: string;
  /** The subject's own SEC code, used only to mark which peers EDGAR files elsewhere. */
  sic: string | null;
}

/** Filings whose language sits nearest this one's (roadmap 9.1).
 *
 * Self-fetching, and last in the dashboard for that reason: it cannot render on the body's
 * first commit, and a section that arrives late must have nothing below it to displace
 * (frontend/CLAUDE.md). A reserved skeleton would be the wrong fix — it collapses whenever the
 * result is empty, which is a shift of its own. */
export default function SimilarLanguage({
  analysisId,
  ticker,
  sic,
}: SimilarLanguageProps) {
  const [state, setState] = useState<SimilarState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Peers become answerable only once the filing has a centroid, which the background
  // indexer fills in after the analysis returns. Sharing the Ask card's poll rather than
  // opening a second one.
  const { completions } = useIndexStatus(analysisId);

  useEffect(() => {
    let cancelled = false;

    // Driven from the promise callback, never a synchronous setState in the effect body
    // (eslint set-state-in-effect).
    getSimilarFilings(analysisId)
      .then((data) => {
        if (cancelled) return;
        setState(similarState(data, sic));
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Something went wrong — try again.",
        );
      });

    return () => {
      cancelled = true;
    };
    // `completions` refetches when indexing finishes: the first fetch may have found no
    // centroid at all, or one derived from part of the filing — a ranking that was right
    // when it was made and is wrong now.
  }, [analysisId, sic, attempt, completions]);

  if (!state && !error) return null;

  return (
    <section aria-label="Similar filing language">
      <SectionHeader icon={Waypoints} title="Similar Filing Language" />
      <p className="mb-3 mt-2.5 text-sm text-muted">
        Ranked by how closely each filing&apos;s wording matches this one, drawn
        from the filings analyzed on this site rather than from EDGAR as a
        whole.
      </p>

      {error && (
        <div>
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
            className="mt-3 inline-flex h-11 cursor-pointer items-center border border-text px-4 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Retry
          </button>
        </div>
      )}

      {state?.kind === "unavailable" && (
        <p className="text-sm text-muted">
          This filing hasn&apos;t been indexed yet, so it can&apos;t be placed
          against the others. It becomes comparable once indexing finishes.
        </p>
      )}

      {state?.kind === "too-small" && (
        <p className="text-sm text-muted">
          Not enough filings have been analyzed here yet to rank this one
          against them. Analyze a few more companies and this fills in.
        </p>
      )}

      {state?.kind === "ready" && (
        <>
          <p className="mb-2 font-sans text-2xs text-muted">
            {poolCaption(state.pool)}
          </p>
          <ol>
            {state.rows.map((row, i) => (
              <li
                key={row.analysisId}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5 border-b border-border last:border-b-0"
              >
                <span className="pt-3.5 font-sans text-2xs tabular-nums text-muted">
                  {i + 1}
                </span>
                <Link
                  href={`/analysis/${row.analysisId}`}
                  className="flex min-h-11 flex-col justify-center gap-0.5 py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-sans text-xs font-semibold tracking-[0.06em] text-text">
                      {row.ticker}
                    </span>
                    <span className="min-w-0 truncate text-sm text-text">
                      {row.companyName}
                    </span>
                    <FormBadge formType={row.formType} />
                  </span>
                  {row.industry && (
                    /* A plain span, not IndustryLine: that renders its own link, and a link
                       inside this row link is invalid markup and an axe nested-interactive
                       violation. Never a chip either (docs/design-system.md). */
                    <span className="font-sans text-2xs text-muted">
                      {row.industry}
                      {row.differentIndustry &&
                        " · filed under a different industry"}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ol>
          <Link
            href={benchmarkHref(ticker, state.rows)}
            className="mt-3 inline-flex h-11 cursor-pointer items-center border border-text px-4 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Benchmark these
          </Link>
        </>
      )}
    </section>
  );
}
