import { formatDate } from "@/lib/format";
import { formDescription } from "@/lib/filings";
import type { Filing } from "@/lib/types";
import FormBadge from "./FormBadge";

interface FilingListProps {
  filings: Filing[];
  onAnalyze: (filing: Filing) => void;
  isAnalyzing: boolean;
}

export default function FilingList({
  filings,
  onAnalyze,
  isAnalyzing,
}: FilingListProps) {
  return (
    <div className="space-y-2">
      {filings.map((filing) => (
        <div
          key={filing.accession_number}
          className="flex items-center justify-between border border-border bg-surface px-4 py-3 transition-colors duration-200 hover:border-primary/50"
        >
          <div className="flex items-center gap-3">
            <FormBadge formType={filing.form_type} />
            {formDescription(filing.form_type) && (
              <span className="text-text">
                {formDescription(filing.form_type)}
              </span>
            )}
            <span className="font-sans text-sm tabular-nums text-muted">
              {formatDate(filing.filing_date)}
            </span>
          </div>
          <button
            onClick={() => onAnalyze(filing)}
            disabled={isAnalyzing}
            className="h-11 cursor-pointer border border-text px-4 font-sans text-xs tracking-[0.06em] text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isAnalyzing ? "Analyzing…" : "Analyze"}
          </button>
        </div>
      ))}
    </div>
  );
}
