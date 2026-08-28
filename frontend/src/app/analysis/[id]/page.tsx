"use client";

import { useCallback, useEffect, useState, use } from "react";
import { FileQuestion } from "lucide-react";
import {
  getAnalysis,
  getFilings,
  getFinancials,
  listAnalyses,
  ApiError,
} from "@/lib/api";
import type {
  AnalysisResponse,
  AnnualFinancials,
  Filing,
  QuarterlyFinancials,
} from "@/lib/types";
import AnalysisDashboard from "@/components/AnalysisDashboard";
import EmptyState from "@/components/EmptyState";
import { SkeletonDashboard } from "@/components/Skeleton";

export default function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [tickerHistory, setTickerHistory] = useState<AnalysisResponse[]>([]);
  const [annualFinancials, setAnnualFinancials] = useState<AnnualFinancials[]>(
    [],
  );
  const [quarterlyFinancials, setQuarterlyFinancials] = useState<
    QuarterlyFinancials[]
  >([]);
  const [latestFiling, setLatestFiling] = useState<Filing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    getAnalysis(Number(id))
      .then(async (result) => {
        setAnalysis(result);
        // Trend data and the newer-filing check are best-effort — the dashboard
        // renders without either.
        const [history, financials, filings] = await Promise.allSettled([
          listAnalyses(12, 0, result.ticker),
          getFinancials(result.cik),
          getFilings(result.cik, "10-K,10-Q", 1),
        ]);
        setTickerHistory(
          history.status === "fulfilled" ? history.value.analyses : [],
        );
        setAnnualFinancials(
          financials.status === "fulfilled" ? financials.value.years : [],
        );
        // `?? []` tolerates a backend that predates the quarters field
        setQuarterlyFinancials(
          financials.status === "fulfilled"
            ? (financials.value.quarters ?? [])
            : [],
        );
        setLatestFiling(
          filings.status === "fulfilled" ? (filings.value[0] ?? null) : null,
        );
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
        } else {
          setError(e instanceof Error ? e.message : "Failed to load analysis");
        }
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function retry() {
    setError(null);
    setNotFound(false);
    load();
  }

  if (notFound) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Analysis not found"
        message="It may have been removed, or the link is wrong."
        action={{ href: "/", label: "Search a ticker" }}
      />
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <p role="alert" className="text-negative">
          {error}
        </p>
        <button
          onClick={retry}
          className="mt-4 h-11 cursor-pointer rounded-lg border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!analysis) {
    return <SkeletonDashboard />;
  }

  return (
    <AnalysisDashboard
      analysis={analysis}
      tickerHistory={tickerHistory}
      annualFinancials={annualFinancials}
      quarterlyFinancials={quarterlyFinancials}
      latestFiling={latestFiling}
    />
  );
}
