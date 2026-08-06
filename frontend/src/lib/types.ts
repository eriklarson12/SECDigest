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
