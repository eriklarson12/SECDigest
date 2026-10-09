from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
_CIK_RE = re.compile(r"^\d{1,10}$")
_ACCESSION_RE = re.compile(r"^\d{10}-?\d{2}-?\d{6}$")
_DOCUMENT_RE = re.compile(r"^[A-Za-z0-9._\-/]{1,255}$")
_ALLOWED_FORM_TYPES = {"10-K", "10-Q", "10-K/A", "10-Q/A"}


# --- EDGAR response models ---

class CompanySearchResult(BaseModel):
    cik: str
    ticker: str
    name: str


class Filing(BaseModel):
    """`items` carries the 8-K item codes ("2.02", "9.01") the submissions feed reports
    for a filing. EDGAR populates it on 8-K forms only, so it is empty for a 10-K or 10-Q
    and for rows that predate the field."""

    accession_number: str
    form_type: str
    filing_date: str
    primary_document: str
    primary_doc_description: str | None = None
    items: list[str] = Field(default_factory=list)


class CompanyProfile(BaseModel):
    """The filer's own SEC classification, from the submissions feed.

    `sic` stays a string: codes are zero-padded four-character identifiers, and int('0700')
    is a different code. EDGAR returns absent fields as empty strings, which services/edgar.py
    normalizes to None — every field here is independently missing for a good share of filers."""

    cik: str
    sic: str | None = None
    sic_description: str | None = None
    owner_org: str | None = None


class CompanyPeers(BaseModel):
    """Listed companies filed under the same SEC SIC as `cik`, most prominent first.

    Membership is the filer's own EDGAR self-classification, not an analyst's judgement —
    a surface rendering this MUST say so. `peers` includes the requested company itself,
    because /benchmark seeds from a SIC alone and would otherwise omit its own subject."""

    cik: str
    sic: str | None = None
    sic_description: str | None = None
    peers: list[CompanySearchResult] = []


class InsiderTransaction(BaseModel):
    """One open-market trade from a Form 4's non-derivative table (roadmap 12.5)."""

    accession_number: str
    filing_date: str
    transaction_date: str | None = None
    owner_name: str
    role: str
    # P = open-market purchase, S = open-market sale. Grants, exercises and withholding are not listed.
    code: Literal["P", "S"]
    shares: float
    price: float | None = None
    value: float | None = None
    # Filed as executed under a Rule 10b5-1 plan, so the trade was scheduled in advance.
    planned: bool = False


class InsiderActivity(BaseModel):
    """Open-market insider trades in Form 4s filed within `window_days`, newest first.

    `filings_scanned` counts the Form 4s read; `truncated` means the scan hit its cap with every
    filing still inside the window, so older ones may be missing. `net_value` sums priced rows only;
    `unpriced_count` says how many it left out."""

    cik: str
    window_days: int
    filings_scanned: int
    filings_failed: int = 0
    filings_without_trades: int = 0
    truncated: bool = False
    net_shares: float = 0
    net_value: float = 0
    unpriced_count: int = 0
    transactions: list[InsiderTransaction] = []


# --- XBRL financials (services/xbrl.py) ---

class AnnualFinancials(BaseModel):
    fiscal_year: int
    # End date of the year's income-statement fact; matches a 10-K to its row (roadmap 12.2).
    period_end: str | None = None
    revenue: float | None = None
    net_income: float | None = None
    eps_diluted: float | None = None
    operating_cash_flow: float | None = None
    # Balance-sheet figures — instant XBRL facts, measured at fiscal-year end.
    cash: float | None = None
    total_assets: float | None = None
    stockholders_equity: float | None = None
    # Ratio inputs (roadmap 12.6). Capex is a positive payment, as reported.
    capex: float | None = None
    gross_profit: float | None = None
    operating_income: float | None = None
    # Tagged Liabilities, or LiabilitiesAndStockholdersEquity minus total equity when untagged.
    liabilities: float | None = None
    current_assets: float | None = None
    current_liabilities: float | None = None


class QuarterlyFinancials(BaseModel):
    # Labelled by period end date (ISO) — fiscal-quarter numbers vary by
    # company calendar and are deliberately not computed.
    period_end: str
    revenue: float | None = None
    net_income: float | None = None


class Revision(BaseModel):
    """One fiscal period a company has reported more than once, at materially different
    values. "Revised" is the only word for it: nothing in the payload distinguishes an
    error correction from a reclassification or a standard adoption (roadmap 9.3)."""

    fiscal_year: int
    # "revenue" | "net_income" | "operating_cash_flow" — named by the backend because only
    # the series selection knows which metric a concept was chosen for.
    metric: str
    concept: str
    first_val: float
    latest_val: float
    delta_pct: float
    first_accn: str
    latest_accn: str


class Percentile(BaseModel):
    """Where one figure sits among every filer that tagged the same concept for the same frame
    period (roadmap 9.4). Two facts a caption MUST carry: `population` counts filers that tagged
    this concept for this period, not all public companies, and a frame buckets by approximate
    calendar alignment, so `period_end` can fall well outside the calendar year `period` names."""

    # "revenue" | "net_income" | "operating_cash_flow" — named by the backend, like Revision.metric.
    metric: str
    concept: str
    # The XBRL frame period, e.g. "CY2025".
    period: str
    # This filer's own period end inside that frame.
    period_end: str
    value: float
    percentile: float
    population: int


class FinancialsResponse(BaseModel):
    cik: str
    years: list[AnnualFinancials]
    quarters: list[QuarterlyFinancials] = []
    revisions: list[Revision] = []
    percentiles: list[Percentile] = []


# --- LLM structured output ---

class FinancialMetric(BaseModel):
    current: float | None = None
    yoy_change_pct: float | None = None


class FilingAnalysis(BaseModel):
    revenue: FinancialMetric
    net_income: FinancialMetric
    risk_factors: list[str]
    management_guidance: str
    summary: str


# --- Analysis request/response ---

class AnalysisRequest(BaseModel):
    """These fields are interpolated into EDGAR URLs — validators are a security
    boundary (see backend/CLAUDE.md), not cosmetic checks."""

    accession_number: str
    cik: str
    ticker: str
    company_name: str = Field(..., min_length=1, max_length=200)
    form_type: str
    filing_date: str | None = None
    primary_document: str

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, v: str) -> str:
        v = v.strip().upper()
        if not _TICKER_RE.match(v):
            raise ValueError("Invalid ticker format")
        return v

    @field_validator("cik")
    @classmethod
    def validate_cik(cls, v: str) -> str:
        v = v.strip()
        if not _CIK_RE.match(v):
            raise ValueError("Invalid CIK format")
        return v

    @field_validator("accession_number")
    @classmethod
    def validate_accession(cls, v: str) -> str:
        v = v.strip()
        if not _ACCESSION_RE.match(v):
            raise ValueError("Invalid accession number format")
        return v.replace("-", "")

    @field_validator("primary_document")
    @classmethod
    def validate_primary_document(cls, v: str) -> str:
        v = v.strip()
        if not _DOCUMENT_RE.match(v) or ".." in v:
            raise ValueError("Invalid document path")
        return v

    @field_validator("form_type")
    @classmethod
    def validate_form_type(cls, v: str) -> str:
        v = v.strip().upper()
        if v not in _ALLOWED_FORM_TYPES:
            raise ValueError("form_type must be one of 10-K, 10-Q, 10-K/A, 10-Q/A")
        return v


FlagKind = Literal["going_concern", "material_weakness"]


class RedFlag(BaseModel):
    """A condition the filing's own text states (roadmap 12.4). Event flags (8-K 4.01/4.02,
    NT filings) are not stored: the frontend reads them from the live filings feed."""

    kind: FlagKind
    filed_date: str | None = None
    accession_number: str
    form_type: str
    # The sentence that tripped the detector, so a reader can check it against the filing.
    excerpt: str | None = None


class SegmentRow(BaseModel):
    # The XBRL member QName, e.g. "aapl:AmericasSegmentMember" or "country:US".
    member: str
    label: str
    value: float


class RevenueSplit(BaseModel):
    """One axis of a filing's revenue. `rows` plus `reconciling` sum to `total` within 1%; a
    split that does not is never returned (roadmap 12.8)."""

    concept: str
    total: float
    rows: list[SegmentRow]
    # Corporate and reconciling items (JPM), listed apart so the total visibly adds up.
    reconciling: list[SegmentRow] = Field(default_factory=list)


class SegmentRevenue(BaseModel):
    """Revenue by reportable segment and by geography, read from the filing's inline XBRL.
    Both splits None means the filing was read and reports neither, e.g. a single-segment filer.
    The period is None only when the document carries no inline XBRL at all."""

    period_start: str | None = None
    period_end: str | None = None
    segments: RevenueSplit | None = None
    geography: RevenueSplit | None = None


class AnalysisResponse(BaseModel):
    id: int
    accession_number: str
    cik: str
    ticker: str
    company_name: str
    form_type: str
    filing_date: str | None = None
    revenue_current: float | None = None
    revenue_yoy_change_pct: float | None = None
    net_income_current: float | None = None
    net_income_yoy_change_pct: float | None = None
    risk_factors: list[str]
    management_guidance: str | None = None
    summary: str | None = None
    # Chunks the filing splits into. None for rows analyzed before it was recorded.
    chunks_expected: int | None = None
    # SEC classification, copied from the submissions feed at analysis time. None for rows
    # analyzed before it was recorded, and for filers EDGAR never classified.
    sic: str | None = None
    sic_description: str | None = None
    owner_org: str | None = None
    flags: list[RedFlag] = Field(default_factory=list)
    # None for rows analyzed before it was recorded, and when the parse failed.
    segments: SegmentRevenue | None = None
    created_at: str


class AnalysisListResponse(BaseModel):
    analyses: list[AnalysisResponse]
    total: int


class SectorCount(BaseModel):
    """One SEC review office and how many stored analyses fall under it (roadmap 8.5)."""

    # The raw EDGAR value ("06 Technology"), not a display label: the leading office number
    # is the sort key, and stripping it is the frontend's job. None is the unclassified bucket.
    owner_org: str | None = None
    count: int


class SectorCountsResponse(BaseModel):
    sectors: list[SectorCount]


# --- Filing Q&A (roadmap 5.1) ---

class AskRequest(BaseModel):
    question: str

    @field_validator("question")
    @classmethod
    def validate_question(cls, v: str) -> str:
        v = v.strip()
        if not 3 <= len(v) <= 300:
            raise ValueError("Question must be between 3 and 300 characters")
        return v


class AskSource(BaseModel):
    chunk_index: int
    excerpt: str


class AskResponse(BaseModel):
    answer: str
    sources: list[AskSource]
    # Filing's own scale declaration (e.g. "Amounts in millions"), display-ready as a caption.
    # None when the filing never declares one (services/units.py).
    unit_scale: str | None = None


class IndexStatusResponse(BaseModel):
    """Q&A coverage for one filing (GET /analysis/{id}/index-status).
    Indexing runs in the background, so coverage is time-varying; poll until `state` leaves "indexing"."""

    state: Literal["indexing", "complete", "partial", "unavailable"]
    chunks_indexed: int
    chunks_total: int


# --- Ask across a company's filings (roadmap 13.2) ---

class AskScopeFiling(BaseModel):
    analysis_id: int
    accession_number: str
    form_type: str
    filing_date: str | None = None


class AskScopeResponse(BaseModel):
    """The filings a company-level question would search (GET /companies/{cik}/ask-scope), newest first.
    `eligible` is false below two: one filing is the per-filing ask's job, and the page links there."""

    filings: list[AskScopeFiling]
    eligible: bool


class CompanyAskSource(BaseModel):
    analysis_id: int
    accession_number: str
    form_type: str
    filing_date: str | None = None
    chunk_index: int
    excerpt: str
    # This filing's own scale declaration; two years of 10-Ks need not share one.
    unit_scale: str | None = None


class CompanyAskResponse(BaseModel):
    answer: str
    # In excerpt order: the answer's "(excerpt N)" is sources[N - 1].
    sources: list[CompanyAskSource]


class SimilarFiling(BaseModel):
    """One language peer (GET /analysis/{id}/similar). `similarity` is cosine on the filings'
    chunk-embedding centroids — comparable between rows, but not a percentage: across this
    corpus it spans roughly 0.80 to 0.99, so the ordering carries the signal, not the value."""

    analysis_id: int
    accession_number: str
    ticker: str
    company_name: str
    form_type: str
    filing_date: str | None = None
    sic: str | None = None
    sic_description: str | None = None
    similarity: float


class SimilarFilingsResponse(BaseModel):
    """Peers are drawn from the analyzed corpus, never from EDGAR at large, so `pool` is what
    any honest caption has to name. It counts distinct *companies*, matching the RPC's one-row-
    per-company rule."""

    peers: list[SimilarFiling]
    pool: int
    # False when the *subject* has no centroid: never indexed, or indexed short. An empty
    # `peers` list cannot tell that apart from "nothing sits near this filing".
    available: bool


class NovelPassage(BaseModel):
    chunk_index: int
    # Whole sentences: the changed wording, and the prior filing's closest wording to it. None
    # when nothing in the prior filing is close, so the change has no earlier counterpart.
    excerpt: str
    prior_excerpt: str | None = None


class DriftResponse(BaseModel):
    """Language drift against the prior same-form filing (GET /analysis/{id}/drift).

    `carried_over` is the share of prose passages whose best match in the prior filing clears
    the novelty threshold. It is the figure to show. `mean_similarity` is recorded but not for
    display: cosine sits near 0.96 for any same-company pair, so it reads as "unchanged" for
    every filing. Tables and form boilerplate are left out of both the share and the passages:
    they score low because their figures and dates moved, not because the text is new."""

    state: Literal["ok", "no_prior", "not_indexed"]
    prior_analysis_id: int | None = None
    prior_form_type: str | None = None
    prior_filing_date: str | None = None
    carried_over: float | None = None
    mean_similarity: float | None = None
    novel_passages: list[NovelPassage] = Field(default_factory=list)
