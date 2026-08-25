/** EDGAR has a filing the stored analysis hasn't caught up to (or nothing is
 * analyzed yet). Shared by the watchlist badge and the analysis-page banner so
 * the two surfaces can't disagree about what "newer" means.
 *
 * Dates are ISO `YYYY-MM-DD`, which compares correctly as a string. Parsing them
 * into `Date` is what makes `formatDate` timezone-dependent; don't. */
export function hasNewerFiling(
  filingDate: string | null | undefined,
  analysisDate: string | null | undefined
): boolean {
  if (!filingDate) return false;
  if (!analysisDate) return true;
  return filingDate > analysisDate;
}
