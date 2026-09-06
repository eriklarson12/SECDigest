export interface CompanySearchResult {
  cik: string;
  ticker: string;
  name: string;
}

export interface Filing {
  accession_number: string;
  form_type: string;
  filing_date: string;
  primary_document: string;
  primary_doc_description: string | null;
}

export interface AnalysisRequest {
  accession_number: string;
  cik: string;
  ticker: string;
  company_name: string;
  form_type: string;
  filing_date: string | null;
  primary_document: string;
}

export interface AnalysisResponse {
  id: number;
  accession_number: string;
  cik: string;
  ticker: string;
  company_name: string;
  form_type: string;
  filing_date: string | null;
  revenue_current: number | null;
  revenue_yoy_change_pct: number | null;
  net_income_current: number | null;
  net_income_yoy_change_pct: number | null;
  risk_factors: string[];
  management_guidance: string | null;
  summary: string | null;
  // SEC classification, stamped at analysis time. Null for rows analyzed before it was
  // recorded and for filers EDGAR never classified. `owner_org` is carried but not yet
  // rendered — roadmap 8.5 groups the corpus by it.
  sic: string | null;
  sic_description: string | null;
  owner_org: string | null;
  created_at: string;
}

/** GET /api/analysis/sectors — the whole corpus counted by SEC review office (roadmap 8.5).
 * `owner_org` is EDGAR's raw value ("06 Technology"); null is the unclassified bucket.
 * The display label and the ordering are `formatSector`/`compareSectors`, not the wire. */
export interface SectorCount {
  owner_org: string | null;
  count: number;
}

export interface SectorCountsResponse {
  sectors: SectorCount[];
}

export interface CompanyProfile {
  cik: string;
  sic: string | null;
  sic_description: string | null;
  owner_org: string | null;
}

/** GET /api/companies/{cik}/peers — companies filed under the same SEC industry code.
 * `peers` leads with the requested company, which the backend guarantees: the feed it
 * scans is alphabetical and depth-capped, so a late-alphabet filer is missing from it. */
export interface CompanyPeers {
  cik: string;
  sic: string | null;
  sic_description: string | null;
  peers: CompanySearchResult[];
}

/** One filing excerpt an answer was drawn from (POST /analysis/{id}/ask). */
export interface AskSource {
  chunk_index: number;
  excerpt: string;
}

export interface AskResponse {
  answer: string;
  sources: AskSource[];
  /** Filing's own scale declaration (e.g. "Amounts in millions..."). Retrieval rarely
   * surfaces it, so without this caption "$11,133" reads a million times too small. Null if undeclared. */
  unit_scale: string | null;
}

/** Q&A coverage for one filing (GET /analysis/{id}/index-status). Indexing runs in the
 * background, so coverage is time-varying — unanswerable seconds after analysis, answerable minutes later. */
export interface IndexStatus {
  /** "partial" means some chunks landed and some didn't — answerable, but from an
   * incomplete filing. It reads as "complete" to a user unless the card says otherwise. */
  state: "indexing" | "complete" | "partial" | "unavailable";
  chunks_indexed: number;
  chunks_total: number;
}

export interface AnalysisListResponse {
  analyses: AnalysisResponse[];
  total: number;
}

/** Exact as-reported annual figures from SEC XBRL (GET /financials/{cik}). */
export interface AnnualFinancials {
  fiscal_year: number;
  revenue: number | null;
  net_income: number | null;
  eps_diluted: number | null;
  operating_cash_flow: number | null;
  /** Balance-sheet figures — instant XBRL facts, measured at fiscal-year end. */
  cash: number | null;
  total_assets: number | null;
  stockholders_equity: number | null;
}

/** Quarterly XBRL figures, labelled by period end date (fiscal quarters vary). */
export interface QuarterlyFinancials {
  period_end: string;
  revenue: number | null;
  net_income: number | null;
}

export interface FinancialsResponse {
  cik: string;
  years: AnnualFinancials[];
  quarters: QuarterlyFinancials[];
}

/** A company on the localStorage watchlist (lib/watchlist.ts). */
export interface WatchItem {
  ticker: string;
  cik: string;
  name: string;
}

/** One x-axis point on the trend chart, whatever the data source. */
export interface TrendPoint {
  label: string;
  revenue: number | null;
  netIncome: number | null;
}
