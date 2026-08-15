"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAnalysis } from "./api";
import type { CompanySearchResult, Filing } from "./types";

/** Shared "analyze a filing" flow. Callers drive their own full-page LoadingState off
 * `isAnalyzing`; this hook only owns request/navigation/error logic. */
export function useAnalyze() {
  const router = useRouter();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze(company: CompanySearchResult, filing: Filing) {
    setIsAnalyzing(true);
    setError(null);

    try {
      const result = await createAnalysis({
        accession_number: filing.accession_number,
        cik: company.cik,
        ticker: company.ticker,
        company_name: company.name,
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

  return { isAnalyzing, error, analyze, clearError: () => setError(null) };
}
