"use client";

import { FileSearch } from "lucide-react";
import { FORM_FILTERS, nounFor, useFilings } from "@/lib/useFilings";
import type { CompanySearchResult, Filing } from "@/lib/types";
import EmptyState from "./EmptyState";
import FilingList from "./FilingList";
import SegmentedControl from "./SegmentedControl";
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
  const { filings, filter, selectFilter, status, error, retry } = useFilings(company.cik);

  // The heading and the filter render in every state: filtering to a form type the
  // company hasn't filed must not remove the control that gets you back.
  return (
    <div className="mt-6 w-full max-w-xl animate-fade-in-up">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 className="text-lg font-semibold text-text">
            Recent Filings for{" "}
            <span className="font-mono text-primary">{company.ticker}</span>
          </h2>
          <WatchStar
            item={{ ticker: company.ticker, cik: company.cik, name: company.name }}
          />
        </div>
        <SegmentedControl
          label="Filter filings by form type"
          options={FORM_FILTERS}
          value={filter}
          onChange={selectFilter}
        />
      </div>

      {status === "loading" ? (
        <SkeletonFilingList />
      ) : status === "error" ? (
        <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-center">
          <p className="text-sm text-negative">{error}</p>
          <button
            onClick={retry}
            className="mt-2 h-11 cursor-pointer rounded-lg border border-border bg-surface px-5 text-sm font-medium text-text transition-colors duration-200 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Retry
          </button>
        </div>
      ) : filings.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title={`No ${nounFor(filter)} filings found`}
          message={`EDGAR has no matching reports for ${company.ticker}.`}
        />
      ) : (
        <FilingList filings={filings} onAnalyze={onAnalyze} isAnalyzing={isAnalyzing} />
      )}
    </div>
  );
}
