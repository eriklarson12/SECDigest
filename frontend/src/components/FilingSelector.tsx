"use client";

import Link from "next/link";
import { FileSearch } from "lucide-react";
import { listAnalyses } from "@/lib/api";
import { analyzedByAccession } from "@/lib/filings";
import { useSection } from "@/lib/useSection";
import { FORM_FILTERS, nounFor, useFilings } from "@/lib/useFilings";
import type { CompanySearchResult, Filing } from "@/lib/types";
import EmptyState from "./EmptyState";
import { ErrorNotice } from "./ErrorState";
import FilingList from "./FilingList";
import SegmentedControl from "./SegmentedControl";
import WatchStar from "./WatchStar";
import { SkeletonFilingList } from "./Skeleton";

const NOT_ANALYZED = new Map<string, number>();

/** Our own table, served from the list cache: no EDGAR request. */
async function loadAnalyzed(ticker: string): Promise<Map<string, number>> {
  const res = await listAnalyses(20, 0, ticker);
  return analyzedByAccession(res.analyses);
}

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
  const { filings, filter, selectFilter, status, error, retry } = useFilings(
    company.cik,
  );
  const companyHref = `/company/${company.ticker}`;
  // A failed lookup leaves every row on "Analyze", which still works: the backend
  // returns a stored analysis without an LLM call.
  const analyzed = useSection(
    company.ticker,
    loadAnalyzed,
    NOT_ANALYZED,
    "Failed to load analyses",
  );

  // The heading and the filter render in every state: filtering to a form type the
  // company hasn't filed must not remove the control that gets you back.
  return (
    <div className="mt-6 w-full max-w-xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold text-text">
            Recent Filings for{" "}
            <Link
              href={companyHref}
              className="font-sans text-primary underline decoration-primary/40 underline-offset-4 transition-colors duration-150 hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {company.ticker}
            </Link>
          </h2>
          <WatchStar
            item={{
              ticker: company.ticker,
              cik: company.cik,
              name: company.name,
            }}
          />
        </div>
        <div className="flex items-center gap-5">
          <SegmentedControl
            label="Filter filings by form type"
            options={FORM_FILTERS}
            value={filter}
            onChange={selectFilter}
          />
          <Link
            href={companyHref}
            className="inline-flex h-11 items-center whitespace-nowrap font-sans text-2xs tracking-[0.06em] text-muted transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary print:hidden"
          >
            Company page →
          </Link>
        </div>
      </div>

      {status === "loading" ? (
        <SkeletonFilingList />
      ) : status === "error" ? (
        <ErrorNotice
          message={error ?? "Failed to load filings"}
          onRetry={retry}
        />
      ) : filings.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title={`No ${nounFor(filter)} filings found`}
          message={`EDGAR has no matching reports for ${company.ticker}.`}
        />
      ) : (
        <FilingList
          filings={filings}
          onAnalyze={onAnalyze}
          isAnalyzing={isAnalyzing}
          analyzed={analyzed.data}
        />
      )}
    </div>
  );
}
