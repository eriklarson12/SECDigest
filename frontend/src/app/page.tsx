"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SearchBar from "@/components/SearchBar";
import FilingSelector from "@/components/FilingSelector";
import LoadingState from "@/components/LoadingState";
import RecentAnalyses from "@/components/RecentAnalyses";
import { createAnalysis } from "@/lib/api";
import type { CompanySearchResult, Filing } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [selectedCompany, setSelectedCompany] =
    useState<CompanySearchResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAnalyze(filing: Filing) {
    if (!selectedCompany) return;

    setIsAnalyzing(true);
    setError(null);

    try {
      const result = await createAnalysis({
        accession_number: filing.accession_number,
        cik: selectedCompany.cik,
        ticker: selectedCompany.ticker,
        company_name: selectedCompany.name,
        form_type: filing.form_type,
        filing_date: filing.filing_date,
        primary_document: filing.primary_document,
      });
      router.push(`/analysis/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed — try again.");
      setIsAnalyzing(false);
    }
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
            setError(null);
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
