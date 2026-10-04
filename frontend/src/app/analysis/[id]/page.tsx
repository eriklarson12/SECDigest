"use client";

import { useCallback, useEffect, useState, use } from "react";
import { FileQuestion } from "lucide-react";
import {
  getAnalysis,
  getDrift,
  getFilings,
  getFinancials,
  listAnalyses,
  ApiError,
} from "@/lib/api";
import type {
  AnalysisResponse,
  AnnualFinancials,
  DriftResponse,
  Filing,
  QuarterlyFinancials,
} from "@/lib/types";
import { EVENT_SCAN_LIMIT } from "@/lib/eightk";
import { FLAG_SCAN_FORMS, eventFlags, type PanelFlag } from "@/lib/redflags";
import AnalysisDashboard from "@/components/AnalysisDashboard";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
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
  const [drift, setDrift] = useState<DriftResponse | null>(null);
  const [companyFlags, setCompanyFlags] = useState<PanelFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    getAnalysis(Number(id))
      .then(async (result) => {
        setAnalysis(result);
        // Trend data, the newer-filing check and language drift are best-effort — the
        // dashboard renders without any of them. Drift is fetched here rather than by its own
        // card so it lands in this one commit: a self-fetching card above the fold is CLS.
        // The company's red-flag events (roadmap 12.4) come in the same batch for that reason.
        const [history, financials, filings, driftResult, flagRows] = await Promise.allSettled([
          listAnalyses(12, 0, result.ticker),
          getFinancials(result.cik),
          getFilings(result.cik, "10-K,10-Q", 1),
          getDrift(result.id),
          getFilings(result.cik, FLAG_SCAN_FORMS.join(","), EVENT_SCAN_LIMIT),
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
        setDrift(driftResult.status === "fulfilled" ? driftResult.value : null);
        setCompanyFlags(
          flagRows.status === "fulfilled" ? eventFlags(flagRows.value, new Date()) : [],
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
    return <ErrorState message={error} onRetry={retry} inset="page" />;
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
      languageDrift={drift}
      companyFlags={companyFlags}
    />
  );
}
