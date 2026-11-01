import { getPeers, searchCompanies } from "@/lib/api";
import { formatIndustry } from "@/lib/format";
import { TICKER_RE } from "@/lib/ticker";
import type { CompanySearchResult } from "@/lib/types";

/** Each row costs one /api/financials request and that route allows 30/min.
 * The watchlist itself caps at 20, so it alone could blow the budget. */
export const MAX_ROWS = 10;

/** A seed that replaces the watchlist: the companies, whether some did not fit, and
 * the industry it came from (only for a peer seed, for the caption). */
export interface BenchmarkSeed {
  companies: CompanySearchResult[];
  truncated: boolean;
  industry: string | null;
}

/** Valid, upper-cased, de-duplicated tickers from a comma-separated URL param. These URLs
 * are meant to be shared and hand-edited. */
export function parseTickers(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => TICKER_RE.test(t)),
    ),
  ];
}

/** The search result whose ticker is exactly `ticker`, or null. Never throws: an
 * unresolvable ticker is dropped rather than surfaced as an error. */
export async function findCompany(
  ticker: string,
): Promise<CompanySearchResult | null> {
  try {
    const results = await searchCompanies(ticker);
    return results.find((c) => c.ticker.toUpperCase() === ticker) ?? null;
  } catch {
    return null;
  }
}

/** Peers for the seed ticker, or null when it is invalid or did not resolve.
 * Two hops, the same pair `?add=` already makes: the URL carries a ticker because
 * that is what a person can read and type, and the endpoint is keyed on a CIK. */
async function peerSeed(ticker: string): Promise<BenchmarkSeed | null> {
  if (!TICKER_RE.test(ticker)) return null;
  const match = await findCompany(ticker);
  if (!match) return null;
  try {
    const found = await getPeers(match.cik);
    if (found.peers.length === 0) return null;
    return {
      companies: found.peers.slice(0, MAX_ROWS),
      truncated: found.peers.length > MAX_ROWS,
      industry: formatIndustry(found.sic, found.sic_description) ?? null,
    };
  } catch {
    return null;
  }
}

/** An explicit set, from the "Benchmark these" button on a language-peer card (roadmap 9.1).
 * Resolved together, then returned once: the set keeps the order the card ranked it, and
 * an unresolvable ticker is dropped rather than leaving the table on a skeleton. */
async function explicitSeed(raw: string): Promise<BenchmarkSeed | null> {
  const only = parseTickers(raw);
  const capped = only.slice(0, MAX_ROWS);
  const found = (await Promise.all(capped.map(findCompany))).filter(
    (c) => c !== null,
  );
  if (found.length === 0) return null;
  return {
    companies: found,
    truncated: only.length > capped.length,
    industry: null,
  };
}

/** The seed that replaces the watchlist, or null to fall back to it. `?peers=` wins over
 * `?only=`, and a seed that fails to resolve falls through to the next. Either one
 * replaces the watchlist rather than joining it: the caption names where the set came
 * from, and unrelated starred companies under it would make that caption false. */
export async function resolveSeed(
  peers: string,
  only: string,
): Promise<BenchmarkSeed | null> {
  return (
    (peers ? await peerSeed(peers) : null) ??
    (only ? await explicitSeed(only) : null)
  );
}
