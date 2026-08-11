"use client";

import { useState, useEffect, useCallback } from "react";
import { FileSearch } from "lucide-react";
import { getFilings } from "@/lib/api";
import type { CompanySearchResult, Filing } from "@/lib/types";
import EmptyState from "./EmptyState";
import FilingList from "./FilingList";
import WatchStar from "./WatchStar";
import { SkeletonFilingList } from "./Skeleton";

interface FilingSelectorProps {
  company: CompanySearchResult;
  onAnalyze: (filing: Filing) => void;
  isAnalyzing: boolean;
}

export default function FilingSelector({
  company,
  onAnalyze,
  isAnalyzing,
}: FilingSelectorProps) {
  const [filings, setFilings] = useState<Filing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFilings = useCallback(() => {
    getFilings(company.cik)
      .then(setFilings)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load filings"))
      .finally(() => setLoading(false));
  }, [company.cik]);

  useEffect(() => {
    fetchFilings();
  }, [fetchFilings]);

  function retry() {
    setLoading(true);
    setError(null);
    fetchFilings();
  }

  if (loading) {
    return <SkeletonFilingList />;
  }

  if (error) {
    return (
      <div className="mt-6 w-full max-w-xl rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-center">
        <p className="text-sm text-negative">{error}</p>
        <button
          onClick={retry}
          className="mt-2 h-11 cursor-pointer rounded-lg border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  if (filings.length === 0) {
    return (
      <div className="mt-2 w-full max-w-xl">
        <EmptyState
          icon={FileSearch}
          title="No 10-K or 10-Q filings found"
          message={`EDGAR has no annual or quarterly reports for ${company.ticker}.`}
        />
      </div>
    );
  }

  return (
    <div className="mt-6 w-full max-w-xl animate-fade-in-up">
      <div className="mb-3 flex items-center gap-1">
        <h2 className="text-lg font-semibold text-text">
          Recent Filings for{" "}
          <span className="font-mono text-primary">{company.ticker}</span>
        </h2>
        <WatchStar
          item={{ ticker: company.ticker, cik: company.cik, name: company.name }}
        />
      </div>
      <FilingList filings={filings} onAnalyze={onAnalyze} isAnalyzing={isAnalyzing} />
    </div>
  );
}
