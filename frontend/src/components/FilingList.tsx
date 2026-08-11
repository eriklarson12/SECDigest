import { formatDate } from "@/lib/format";
import type { Filing } from "@/lib/types";
import FormBadge from "./FormBadge";

interface FilingListProps {
  filings: Filing[];
  onAnalyze: (filing: Filing) => void;
  isAnalyzing: boolean;
}

export default function FilingList({ filings, onAnalyze, isAnalyzing }: FilingListProps) {
  return (
    <div className="space-y-2">
      {filings.map((filing) => (
        <div
          key={filing.accession_number}
          className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 transition-colors duration-200 hover:border-primary/50"
        >
          <div className="flex items-center">
            <FormBadge formType={filing.form_type} />
            <span className="ml-3 font-mono text-sm tabular-nums text-muted">
              {formatDate(filing.filing_date)}
            </span>
          </div>
          <button
            onClick={() => onAnalyze(filing)}
            disabled={isAnalyzing}
            className="h-11 cursor-pointer rounded-lg bg-primary px-4 text-sm font-medium text-bg transition-colors duration-200 hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isAnalyzing ? "Analyzing…" : "Analyze"}
          </button>
        </div>
      ))}
    </div>
  );
}
