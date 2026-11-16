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

/** Stored analysis ids keyed by dashless accession. EDGAR's feed carries dashes and the
 * `analyses` table does not, so a plain `===` between the two never matches. */
export function analyzedByAccession(
  analyses: { id: number; accession_number: string }[],
): Map<string, number> {
  return new Map(analyses.map((a) => [a.accession_number.replace(/-/g, ""), a.id]));
}

export function analysisIdFor(
  analyzed: Map<string, number>,
  accession: string,
): number | undefined {
  return analyzed.get(accession.replace(/-/g, ""));
}

/** The filing a no-prior analysis would be compared with: the newest one of the same form
 * filed before it. Exact form match, so an amendment is never offered as the prior. */
export function findPriorFiling<
  T extends { form_type: string; filing_date: string },
>(
  filings: T[],
  analysis: { form_type: string; filing_date: string | null },
): T | null {
  const filed = analysis.filing_date;
  if (!filed) return null;
  return (
    filings
      .filter((f) => f.form_type === analysis.form_type && f.filing_date < filed)
      .sort((a, b) => (a.filing_date < b.filing_date ? 1 : -1))[0] ?? null
  );
}
