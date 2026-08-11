"use client";

import { useState } from "react";
import SearchBar from "@/components/SearchBar";
import FilingSelector from "@/components/FilingSelector";
import LoadingState from "@/components/LoadingState";
import RecentAnalyses from "@/components/RecentAnalyses";
import { useAnalyze } from "@/lib/useAnalyze";
import type { CompanySearchResult, Filing } from "@/lib/types";

export default function Home() {
  const [selectedCompany, setSelectedCompany] =
    useState<CompanySearchResult | null>(null);
  const { isAnalyzing, error, analyze, clearError } = useAnalyze();

  function handleAnalyze(filing: Filing) {
    if (!selectedCompany) return;
    analyze(selectedCompany, filing);
  }

  if (isAnalyzing) {
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mt-12 animate-fade-in-up text-center">
        <h1 className="text-4xl font-bold tracking-tight text-text">
          SEC<span className="text-primary">Digest</span>
        </h1>
        <p className="mt-3 max-w-md text-muted">
          Search a ticker, pick a 10-K or 10-Q, and get an AI-generated
          breakdown of revenue, risks, and outlook.
        </p>
      </div>

      <div className="mt-8 flex w-full justify-center">
        <SearchBar
          onSelect={(company) => {
            setSelectedCompany(company);
            clearError();
          }}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative"
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

      {!selectedCompany && <RecentAnalyses />}
    </div>
  );
}
