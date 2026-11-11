import { formatDate } from "@/lib/format";
import { analysisIdFor, formDescription } from "@/lib/filings";
import type { Filing } from "@/lib/types";
import Button from "./Button";
import FormBadge from "./FormBadge";

interface FilingListProps {
  filings: Filing[];
  onAnalyze: (filing: Filing) => void;
  isAnalyzing: boolean;
  /** Stored analyses from `analyzedByAccession`. It lands after the list, so it may only
   * relabel a row's control: both labels are one line in the same `Button`. */
  analyzed?: Map<string, number>;
}

const NONE = new Map<string, number>();

export default function FilingList({
  filings,
  onAnalyze,
  isAnalyzing,
  analyzed = NONE,
}: FilingListProps) {
  return (
    <div className="space-y-2">
      {filings.map((filing) => {
        const id = analysisIdFor(analyzed, filing.accession_number);
        const which = `${filing.form_type} filed ${formatDate(filing.filing_date)}`;
        const label = isAnalyzing ? "Analyzing…" : "Analyze";
        return (
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
            {id !== undefined ? (
              <Button
                href={`/analysis/${id}`}
                ariaLabel={`View analysis of ${which}`}
              >
                View analysis
              </Button>
            ) : (
              <Button
                onClick={() => onAnalyze(filing)}
                disabled={isAnalyzing}
                ariaLabel={`${label} ${which}`}
              >
                {label}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
