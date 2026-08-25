import Link from "next/link";
import { BellRing } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { Filing } from "@/lib/types";

interface NewerFilingBannerProps {
  filing: Filing;
  ticker: string;
}

export default function NewerFilingBanner({ filing, ticker }: NewerFilingBannerProps) {
  return (
    // role="status": this lands after the dashboard has already painted.
    <div
      role="status"
      className="mb-6 flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-text"
    >
      <BellRing
        className="mt-0.5 h-4 w-4 shrink-0 text-accent"
        strokeWidth={1.5}
        aria-hidden
      />
      <p>
        A newer {filing.form_type} was filed{" "}
        <span className="font-mono tabular-nums">
          {formatDate(filing.filing_date)}
        </span>{" "}
        —{" "}
        <Link
          href={`/company/${ticker}`}
          className="rounded font-medium text-accent underline underline-offset-2 transition-colors duration-200 hover:text-accent/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          analyze it from the company&apos;s filings
        </Link>
        .
      </p>
    </div>
  );
}
