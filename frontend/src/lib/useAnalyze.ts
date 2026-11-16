"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { track } from "./analytics";
import { ApiError, createAnalysis, createAnalysisStream } from "./api";
import type { AnalysisStage } from "./api";
import type { CompanySearchResult, Filing } from "./types";

/** Shared "analyze a filing" flow. Callers drive their own full-page LoadingState off
 * `isAnalyzing` and pass `stage` to it; this hook only owns request/navigation/error logic. */
export function useAnalyze() {
  const router = useRouter();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [stage, setStage] = useState<AnalysisStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function analyze(company: CompanySearchResult, filing: Filing) {
    setIsAnalyzing(true);
    setStage(null);
    setError(null);

    const request = {
      accession_number: filing.accession_number,
      cik: company.cik,
      ticker: company.ticker,
      company_name: company.name,
      form_type: filing.form_type,
      filing_date: filing.filing_date,
      primary_document: filing.primary_document,
    };

    const event = { ticker: company.ticker, form: filing.form_type };
    const startedAt = Date.now();
    track("analysis_start", event);

    try {
      let result;
      try {
        result = await createAnalysisStream(request, setStage);
      } catch (e) {
        // Retry unstreamed only when the stream itself failed — a dropped
        // connection or a body that ended mid-pipeline, both status 0. A mapped
        // backend status (502/503/429) is the same answer either way, and asking
        // again spends another of the six requests a minute allows.
        if (!(e instanceof ApiError) || e.status !== 0) throw e;
        setStage(null);
        result = await createAnalysis(request);
      }
      track("analysis_complete", {
        ...event,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
      router.push(`/analysis/${result.id}`);
    } catch (e) {
      track("analysis_error", {
        ...event,
        status: e instanceof ApiError ? e.status : 0,
      });
      setError(e instanceof Error ? e.message : "Analysis failed — try again.");
      setIsAnalyzing(false);
      setStage(null);
    }
  }

  return {
    isAnalyzing,
    stage,
    error,
    analyze,
    clearError: () => setError(null),
  };
}
