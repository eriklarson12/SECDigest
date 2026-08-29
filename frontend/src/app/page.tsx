"use client";

import { useState } from "react";
import SearchBar from "@/components/SearchBar";
import FilingSelector from "@/components/FilingSelector";
import LoadingState from "@/components/LoadingState";
import RecentAnalyses from "@/components/RecentAnalyses";
import StarterTickers from "@/components/StarterTickers";
import WatchlistStrip from "@/components/WatchlistStrip";
import { useAnalyze } from "@/lib/useAnalyze";
import type { CompanySearchResult, Filing } from "@/lib/types";

export default function Home() {
  const [selectedCompany, setSelectedCompany] =
    useState<CompanySearchResult | null>(null);
  const { isAnalyzing, error, analyze, clearError } = useAnalyze();

  function handleSelectCompany(company: CompanySearchResult) {
    setSelectedCompany(company);
    clearError();
  }

  function handleAnalyze(filing: Filing) {
    if (!selectedCompany) return;
    analyze(selectedCompany, filing);
  }

  if (isAnalyzing) {
    return <LoadingState />;
  }

  return (
    <div>
      <h1 className="text-3xl leading-tight text-text">Search a filing</h1>
      <p className="mt-1 text-muted">
        By ticker or company name. Annual and quarterly reports, drawn directly
        from the SEC&rsquo;s EDGAR system.
      </p>

      <div className="mt-5 w-full">
        <SearchBar onSelect={handleSelectCompany} />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 border-l-2 border-negative py-1 pl-3 text-sm text-negative"
        >
          {error}
        </div>
      )}

      {selectedCompany && (
        <FilingSelector
          key={selectedCompany.cik}
          company={selectedCompany}
          onAnalyze={handleAnalyze}
          isAnalyzing={isAnalyzing}
        />
      )}

      {!selectedCompany && (
        <>
          <StarterTickers onSelect={handleSelectCompany} />
          <WatchlistStrip />
          <RecentAnalyses />
        </>
      )}
    </div>
  );
}
