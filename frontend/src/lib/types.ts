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
  created_at: string;
}

/** One filing excerpt an answer was drawn from (POST /analysis/{id}/ask). */
export interface AskSource {
  chunk_index: number;
  excerpt: string;
}

export interface AskResponse {
  answer: string;
  sources: AskSource[];
  /** The filing's own scale declaration for the excerpts behind this answer,
   * e.g. "Amounts in millions, except per share data." Filings state this once
   * in a section header that retrieval rarely returns, so it's shown as a
   * caption — without it "$11,133" reads a million times too small. Rendered
   * as "Source figures as filed: ..." because the answer may have already
   * converted the figure (see scaleCaption in AskFiling.tsx). Null when the
   * filing never declares one. */
  unit_scale: string | null;
}

/** Q&A coverage for one filing (GET /analysis/{id}/index-status).
 *
 * Indexing runs in the background after an analysis, so coverage is
 * time-varying: a question about MD&A can be unanswerable seconds after a
 * filing is analyzed and answerable a few minutes later. */
export interface IndexStatus {
  state: "indexing" | "complete" | "unavailable";
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
