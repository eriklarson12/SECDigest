import type { CompanySearchResult } from "./types";

/** Recently selected companies, newest first — localStorage only (no auth).
 * Every storage access is guarded: SSR and private-browsing must no-op. */

const KEY = "secdigest.recentSearches";
const MAX_RECENT = 5;

export function getRecent(): CompanySearchResult[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is CompanySearchResult =>
        typeof c?.ticker === "string" &&
        typeof c?.cik === "string" &&
        typeof c?.name === "string"
    );
  } catch {
    return [];
  }
}

export function addRecent(company: CompanySearchResult): void {
  if (typeof window === "undefined") return;
  try {
    const next = [
      company,
      ...getRecent().filter((c) => c.ticker !== company.ticker),
    ].slice(0, MAX_RECENT);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable — recents are a convenience, never an error
  }
}
