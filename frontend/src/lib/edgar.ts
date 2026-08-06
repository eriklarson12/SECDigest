/** EDGAR public URLs (not formatting — see docs/edgar.md for URL quirks). */

/** Filing index page on SEC.gov: unpadded CIK, dashless accession. */
export function edgarFilingIndexUrl(cik: string, accession: string): string {
  const cikUnpadded = String(Number(cik));
  const accessionDashless = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${accessionDashless}/`;
}
