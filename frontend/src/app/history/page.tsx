"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { listAnalyses } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { formatIndustry } from "@/lib/format";
import type { AnalysisResponse } from "@/lib/types";
import AnalysisHistory from "@/components/AnalysisHistory";
import { SkeletonTableRows } from "@/components/Skeleton";

const PAGE_SIZE = 20;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const SIC_RE = /^\d{1,4}$/;

function HistoryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Arrives from the industry line on an analysis or company page. A hand-edited
  // junk value degrades to the unfiltered page rather than a 422 from the backend.
  const rawSic = searchParams.get("sic");
  const sic = rawSic && SIC_RE.test(rawSic) ? rawSic : null;

  const [analyses, setAnalyses] = useState<AnalysisResponse[]>([]);
  const [total, setTotal] = useState(0);
  // The description is carried by the rows, so a filter that matches nothing has none.
  // Remembering the last one seen keeps the label whole when a second filter empties the
  // page; it is stored with its code so a different one can never inherit it.
  const [sicLabel, setSicLabel] = useState<{
    code: string;
    description: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState<string | undefined>(undefined);
  // The effect below fetches on a `sic` change and must carry the ticker filter with
  // it; reading `filter` there would make the effect refire on every ticker change too,
  // which `commitFilter` already handles.
  const filterRef = useRef<string | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchPage = useCallback(
    (tickerFilter: string | undefined, sicFilter: string | null) => {
      listAnalyses(PAGE_SIZE, 0, tickerFilter, sicFilter ?? undefined)
        .then((res) => {
          setAnalyses(res.analyses);
          setTotal(res.total);
          setHasMore(res.analyses.length === PAGE_SIZE);
          const description = res.analyses[0]?.sic_description;
          if (sicFilter && description)
            setSicLabel({ code: sicFilter, description });
        })
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Failed to load history"),
        )
        .finally(() => setLoading(false));
    },
    [],
  );

  // Owns every sic-driven fetch, including the first load. Handlers that change `sic`
  // navigate and leave the fetch to this; handlers that only change the ticker fetch
  // directly. Splitting it that way is what keeps a clear from fetching twice.
  useEffect(() => {
    fetchPage(filterRef.current, sic);
  }, [fetchPage, sic]);

  // Cleanup only — the filter fetch itself is always triggered from an event handler.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function retry() {
    fetchPage(filter, sic);
  }

  // Click-handler driven; errors never clear rows already on screen
  function loadMore() {
    setLoadingMore(true);
    setError(null);
    listAnalyses(PAGE_SIZE, analyses.length, filter, sic ?? undefined)
      .then((res) => {
        setAnalyses((prev) => [...prev, ...res.analyses]);
        setHasMore(res.analyses.length === PAGE_SIZE);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load more"),
      )
      .finally(() => setLoadingMore(false));
  }

  function commitFilter(raw: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const upper = raw.trim().toUpperCase();
    const next = TICKER_RE.test(upper) ? upper : undefined;
    setFilter(next);
    filterRef.current = next;
    setLoading(true);
    setError(null);
    fetchPage(next, sic);
  }

  function handleFilterChange(value: string) {
    setFilterInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitFilter(value), 300);
  }

  function handleFilterKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitFilter(filterInput);
    }
  }

  function clearSicFilter() {
    setLoading(true);
    setError(null);
    // Dropping the param is the fetch trigger — a reload must not restore the filter.
    router.replace("/history", { scroll: false });
  }

  function clearAllFilters() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setFilterInput("");
    setFilter(undefined);
    filterRef.current = undefined;
    setLoading(true);
    setError(null);
    if (sic) {
      router.replace("/history", { scroll: false });
    } else {
      fetchPage(undefined, null);
    }
  }

  // From the rows, never from the URL: the link carries only the code, and every stored
  // analysis of that code carries the same description.
  const industry = sic
    ? (formatIndustry(
        sic,
        sicLabel?.code === sic ? sicLabel.description : null,
      ) ?? undefined)
    : undefined;
  const filterLabel = [filter, industry].filter(Boolean).join(" · ") || undefined;

  const buttonClass =
    "h-11 cursor-pointer border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl text-text">Analysis History</h1>
        {!loading && analyses.length > 0 && (
          <button
            onClick={() => downloadCsv(analyses)}
            className="inline-flex h-11 cursor-pointer items-center gap-2 border border-text px-4 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Download className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            Export CSV
          </button>
        )}
      </div>
      <div className="mb-4">
        <input
          type="text"
          value={filterInput}
          onChange={(e) => handleFilterChange(e.target.value)}
          onKeyDown={handleFilterKeyDown}
          placeholder="Filter by ticker…"
          aria-label="Filter history by ticker"
          className="h-11 w-full border-0 border-b border-text bg-transparent px-1 text-text placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:w-64"
        />
      </div>
      {(industry || filter) && (
        <div className="mb-4 font-sans text-2xs text-muted">
          {industry && (
            <p data-testid="active-sic-filter">
              Filtered to {industry}{" "}
              <button
                onClick={clearSicFilter}
                className="ml-1 cursor-pointer underline transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Clear
              </button>
            </p>
          )}
          {!loading && (
            <p className="tabular-nums" data-testid="filter-count">
              {total} {total === 1 ? "analysis" : "analyses"}
            </p>
          )}
        </div>
      )}
      {loading ? (
        <SkeletonTableRows rows={6} />
      ) : error && analyses.length === 0 ? (
        <div className="py-16 text-center">
          <p role="alert" className="text-negative">
            {error}
          </p>
          <button onClick={retry} className={`mt-4 ${buttonClass}`}>
            Retry
          </button>
        </div>
      ) : (
        <div>
          <AnalysisHistory
            analyses={analyses}
            filterLabel={filterLabel}
            onClearFilter={clearAllFilters}
          />
          {loadingMore && (
            <div className="mt-3">
              <SkeletonTableRows rows={3} />
            </div>
          )}
          {error && analyses.length > 0 && !loadingMore && (
            <div className="mt-6 text-center">
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
              <button onClick={loadMore} className={`mt-3 ${buttonClass}`}>
                Retry
              </button>
            </div>
          )}
          {hasMore && !loadingMore && !error && (
            <div className="mt-6 text-center">
              <button onClick={loadMore} className={buttonClass}>
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the App Router
export default function HistoryPage() {
  return (
    <Suspense fallback={<SkeletonTableRows rows={6} />}>
      <HistoryContent />
    </Suspense>
  );
}
