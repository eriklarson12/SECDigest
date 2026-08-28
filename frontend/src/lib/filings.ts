/** EDGAR has a filing the stored analysis hasn't caught up to (or nothing is
 * analyzed yet). Shared by the watchlist badge and the analysis-page banner so
 * the two surfaces can't disagree about what "newer" means.
 *
 * Dates are ISO `YYYY-MM-DD`, which compares correctly as a string. Parsing them
 * into `Date` is what makes `formatDate` timezone-dependent; don't. */
export function hasNewerFiling(
  filingDate: string | null | undefined,
  analysisDate: string | null | undefined,
): boolean {
  if (!filingDate) return false;
  if (!analysisDate) return true;
  return filingDate > analysisDate;
}

/** What the form actually is, spelled out. "10-K" and "10-Q" differ by one
 * character in a small label, which is not enough to scan a list by.
 * `startsWith` so amendments ("10-K/A") describe as their parent form. */
export function formDescription(formType: string): string | null {
  if (formType.startsWith("10-K")) return "Annual report";
  if (formType.startsWith("10-Q")) return "Quarterly report";
  return null;
}
