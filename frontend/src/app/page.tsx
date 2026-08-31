"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SearchBar from "@/components/SearchBar";
import FilingSelector from "@/components/FilingSelector";
import HowItWorks from "@/components/HowItWorks";
import LoadingState from "@/components/LoadingState";
import RecentAnalyses from "@/components/RecentAnalyses";
import StarterTickers from "@/components/StarterTickers";
import StarredCompanies from "@/components/StarredCompanies";
import { searchCompanies } from "@/lib/api";
import { useAnalyze } from "@/lib/useAnalyze";
import type { CompanySearchResult, Filing } from "@/lib/types";

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** Which half of the homepage shows — the picked company's filings, or the
 * starting sections — is decided by `?ticker=`, not by state alone. A `Link`
 * to "/" from "/" re-renders the same tree and keeps its state, so a
 * state-only selection survives the header's Home link and the wordmark. */
function HomeBody({
  company,
  onResolve,
  onSelect,
  onAnalyze,
  isAnalyzing,
}: {
  company: CompanySearchResult | null;
  onResolve: (company: CompanySearchResult) => void;
  onSelect: (company: CompanySearchResult) => void;
  onAnalyze: (filing: Filing) => void;
  isAnalyzing: boolean;
}) {
  const searchParams = useSearchParams();
  const wanted = searchParams.get("ticker")?.trim().toUpperCase() ?? null;
  const selected =
    company && company.ticker.toUpperCase() === wanted ? company : null;

  // A reloaded or shared `?ticker=` has no state behind it. Resolve it the way
  // /compare resolves its own; an unknown ticker degrades to the plain
  // homepage rather than an error.
  useEffect(() => {
    if (!wanted || selected || !TICKER_RE.test(wanted)) return;
    let cancelled = false;

    (async () => {
      try {
        const results = await searchCompanies(wanted);
        const match = results.find((c) => c.ticker.toUpperCase() === wanted);
        if (match && !cancelled) onResolve(match);
      } catch {
        // best-effort — the search box above is still there
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wanted, selected, onResolve]);

  if (selected) {
    return (
      <FilingSelector
        key={selected.cik}
        company={selected}
        onAnalyze={onAnalyze}
        isAnalyzing={isAnalyzing}
      />
    );
  }

  return (
    <>
      <StarredCompanies />
      <StarterTickers onSelect={onSelect} />
      {/* `RecentAnalyses` renders nothing until its fetch resolves, so it MUST
          stay last: `main` is the final element in the layout, and a section
          appended below everything displaces nothing. Above `HowItWorks` it
          moved a painted node and cost 0.035 CLS. */}
      <HowItWorks />
      <RecentAnalyses />
    </>
  );
}

export default function Home() {
  const router = useRouter();
  const [company, setCompany] = useState<CompanySearchResult | null>(null);
  const { isAnalyzing, stage, error, analyze, clearError } = useAnalyze();

  function handleSelectCompany(next: CompanySearchResult) {
    setCompany(next);
    clearError();
    // push, not replace — Back should undo a selection, the way Home does
    router.push(`/?ticker=${encodeURIComponent(next.ticker)}`, {
      scroll: false,
    });
  }

  function handleAnalyze(filing: Filing) {
    if (!company) return;
    analyze(company, filing);
  }

  if (isAnalyzing) {
    return <LoadingState stage={stage} />;
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold leading-tight text-text">
        Search a Filing
      </h1>
      <p className="mt-1 text-muted">
        Annual and quarterly reports, drawn directly from the SEC&rsquo;s EDGAR
        system.
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

      {/* useSearchParams needs a Suspense boundary; drawing it here keeps the
          heading and the search box in the prerendered HTML. The method note is
          the fallback because it is the only part of the body that never
          depends on the URL — everything else already waits for the client. */}
      <Suspense fallback={<HowItWorks />}>
        <HomeBody
          company={company}
          onResolve={setCompany}
          onSelect={handleSelectCompany}
          onAnalyze={handleAnalyze}
          isAnalyzing={isAnalyzing}
        />
      </Suspense>
    </div>
  );
}
