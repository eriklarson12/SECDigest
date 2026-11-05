/** EDGAR public URLs (not formatting — see docs/edgar.md for URL quirks). */

/** Filing index page on SEC.gov: unpadded CIK, dashless accession. */
export function edgarFilingIndexUrl(cik: string, accession: string): string {
  const cikUnpadded = String(Number(cik));
  const accessionDashless = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${accessionDashless}/`;
}

/** One document inside a filing's folder on SEC.gov. */
export function edgarDocumentUrl(
  cik: string,
  accession: string,
  document: string,
): string {
  return edgarFilingIndexUrl(cik, accession) + encodeURIComponent(document);
}
