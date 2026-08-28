import { getFilings, listAnalyses } from "./api";
import { hasNewerFiling } from "./filings";
import type { AnalysisResponse, Filing, WatchItem } from "./types";

/** Latest EDGAR filing vs. latest stored analysis for one watched company.
 *
 * Two surfaces need this — the homepage strip and `/watchlist` — and each one
 * costs two requests per company. A 20-item watchlist is 40 calls, against a
 * 30/min limit on `/api/filings`, so navigating between them uncached starts
 * returning 429s. Results are cached here for both. */

export interface WatchStatus {
  item: WatchItem;
  status: "ready" | "error";
  latestFiling: Filing | null;
  latestAnalysis: AnalysisResponse | null;
}

/** Long enough to cover a session's navigation, short enough that a filing
 * published mid-session shows up on a revisit. */
const TTL_MS = 10 * 60 * 1000;

/** The promise is cached, not the result: two surfaces mounting in the same
 * tick share one in-flight request instead of racing to fill the entry. */
const cache = new Map<string, { at: number; promise: Promise<WatchStatus> }>();

/** In-memory only. sessionStorage would survive a hard reload, at the cost of
 * serialization plus the SSR and private-browsing guards every storage access
 * in this app carries — and the path that matters, a client-side nav from the
 * homepage to `/watchlist`, is already covered. */
export function loadWatchStatus(item: WatchItem): Promise<WatchStatus> {
  const hit = cache.get(item.ticker);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;

  const promise = fetchStatus(item);
  cache.set(item.ticker, { at: Date.now(), promise });
  return promise;
}

async function fetchStatus(item: WatchItem): Promise<WatchStatus> {
  const [filings, analyses] = await Promise.allSettled([
    getFilings(item.cik, "10-K,10-Q", 1),
    listAnalyses(1, 0, item.ticker),
  ]);

  // A failed lookup is evicted rather than cached — otherwise one bad response
  // pins the company as broken for the full TTL. The next surface retries.
  if (filings.status !== "fulfilled") {
    cache.delete(item.ticker);
    return { item, status: "error", latestFiling: null, latestAnalysis: null };
  }

  return {
    item,
    status: "ready",
    latestFiling: filings.value[0] ?? null,
    latestAnalysis:
      analyses.status === "fulfilled"
        ? (analyses.value.analyses[0] ?? null)
        : null,
  };
}

/** EDGAR has a filing the stored record hasn't caught up to — worth a visit.
 * Shared so the homepage count and the watchlist badge cannot disagree. */
export function hasNewFiling(status: WatchStatus): boolean {
  if (status.status !== "ready") return false;
  return hasNewerFiling(
    status.latestFiling?.filing_date,
    status.latestAnalysis?.filing_date,
  );
}

/** Test hook — the cache is module state and outlives a single test. */
export function clearWatchStatusCache(): void {
  cache.clear();
}
