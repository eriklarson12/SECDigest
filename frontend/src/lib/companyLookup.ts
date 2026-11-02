import { searchCompanies } from "@/lib/api";
import type { CompanySearchResult } from "@/lib/types";

/** The search result whose ticker is exactly `ticker` (upper-cased), or null. The
 * search falls back to prefix matches, so the exact one is not always first. Rejects
 * when the search fails, so a caller can tell "no such ticker" from "couldn't check". */
export async function lookupCompany(
  ticker: string,
): Promise<CompanySearchResult | null> {
  const results = await searchCompanies(ticker);
  return results.find((c) => c.ticker.toUpperCase() === ticker) ?? null;
}

/** `lookupCompany` for best-effort callers: a failed search reads as no match. */
export async function findCompany(
  ticker: string,
): Promise<CompanySearchResult | null> {
  try {
    return await lookupCompany(ticker);
  } catch {
    return null;
  }
}
