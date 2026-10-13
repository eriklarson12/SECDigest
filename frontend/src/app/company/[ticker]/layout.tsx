import type { Metadata } from "next";
import { companyFeedUrl } from "@/lib/api";

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** The page is a client component and cannot export metadata, so feed
 * autodiscovery (roadmap 14.1) lives here. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>;
}): Promise<Metadata> {
  const ticker = (await params).ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) return {};
  return {
    alternates: {
      types: {
        "application/atom+xml": [
          { url: companyFeedUrl(ticker), title: `${ticker} filings` },
        ],
      },
    },
  };
}

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
