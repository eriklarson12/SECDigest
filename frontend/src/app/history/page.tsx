"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { listAnalyses } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import type { AnalysisResponse } from "@/lib/types";
import AnalysisHistory from "@/components/AnalysisHistory";
import { SkeletonTableRows } from "@/components/Skeleton";

const PAGE_SIZE = 20;

export default function HistoryPage() {
  const [analyses, setAnalyses] = useState<AnalysisResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = useCallback(() => {
    listAnalyses(PAGE_SIZE, 0)
      .then((res) => {
        setAnalyses(res.analyses);
        setHasMore(res.analyses.length === PAGE_SIZE);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load history"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  function retry() {
    setLoading(true);
    setError(null);
    loadFirstPage();
  }

  // Click-handler driven; errors never clear rows already on screen
  function loadMore() {
    setLoadingMore(true);
    setError(null);
    listAnalyses(PAGE_SIZE, analyses.length)
      .then((res) => {
        setAnalyses((prev) => [...prev, ...res.analyses]);
        setHasMore(res.analyses.length === PAGE_SIZE);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load more"))
      .finally(() => setLoadingMore(false));
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
          <AnalysisHistory analyses={analyses} />
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
