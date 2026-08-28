"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { listAnalyses } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import type { AnalysisResponse } from "@/lib/types";
import AnalysisHistory from "@/components/AnalysisHistory";
import { SkeletonTableRows } from "@/components/Skeleton";

const PAGE_SIZE = 20;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export default function HistoryPage() {
  const [analyses, setAnalyses] = useState<AnalysisResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchPage = useCallback((tickerFilter: string | undefined) => {
    listAnalyses(PAGE_SIZE, 0, tickerFilter)
      .then((res) => {
        setAnalyses(res.analyses);
        setHasMore(res.analyses.length === PAGE_SIZE);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load history"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPage(undefined);
  }, [fetchPage]);

  // Cleanup only — the filter fetch itself is always triggered from an event handler.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function retry() {
    fetchPage(filter);
  }

  // Click-handler driven; errors never clear rows already on screen
  function loadMore() {
    setLoadingMore(true);
    setError(null);
    listAnalyses(PAGE_SIZE, analyses.length, filter)
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
    setLoading(true);
    setError(null);
    fetchPage(next);
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

  function clearFilter() {
    setFilterInput("");
    commitFilter("");
  }

  const buttonClass =
    "h-11 cursor-pointer rounded-lg border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">Analysis History</h1>
        {!loading && analyses.length > 0 && (
          <button
            onClick={() => downloadCsv(analyses)}
            className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
          className="h-11 w-full rounded-lg border border-border bg-surface px-4 text-text placeholder:text-muted transition-colors duration-200 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 sm:w-64"
        />
      </div>
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
        <div className="animate-fade-in-up">
          <AnalysisHistory
            analyses={analyses}
            filter={filter}
            onClearFilter={clearFilter}
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
