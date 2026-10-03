import Link from "next/link";
import { BellRing } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { Filing } from "@/lib/types";

interface NewerFilingBannerProps {
  filing: Filing;
  ticker: string;
  /** The newer filing's "what changed" page, when it is analyzed and pairs with this one. */
  changesHref?: string;
}

const LINK_CLASS =
  "font-medium text-accent underline underline-offset-2 transition-colors duration-200 hover:text-accent/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

export default function NewerFilingBanner({
  filing,
  ticker,
  changesHref,
}: NewerFilingBannerProps) {
  return (
    // role="status": this lands after the dashboard has already painted.
    <div
      role="status"
      className="mb-6 flex items-start gap-2 border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-text"
    >
      <BellRing
        className="mt-0.5 h-4 w-4 shrink-0 text-accent"
        strokeWidth={1.5}
        aria-hidden
      />
      <p>
        A newer {filing.form_type} was filed{" "}
        <span className="font-sans tabular-nums">
          {formatDate(filing.filing_date)}
        </span>{" "}
        —{" "}
        {changesHref ? (
          <Link href={changesHref} className={LINK_CLASS}>
            see what changed
          </Link>
        ) : (
          <Link href={`/company/${ticker}`} className={LINK_CLASS}>
            analyze it from the company&apos;s filings
          </Link>
        )}
        .
      </p>
    </div>
  );
}
