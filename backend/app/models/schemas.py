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
    accession_number: str
    form_type: str
    filing_date: str
    primary_document: str
    primary_doc_description: str | None = None


# --- XBRL financials (services/xbrl.py) ---

class AnnualFinancials(BaseModel):
    fiscal_year: int
    revenue: float | None = None
    net_income: float | None = None
    eps_diluted: float | None = None
    operating_cash_flow: float | None = None
    # Balance-sheet figures — instant XBRL facts, measured at fiscal-year end.
    cash: float | None = None
    total_assets: float | None = None
    stockholders_equity: float | None = None


class QuarterlyFinancials(BaseModel):
    # Labelled by period end date (ISO) — fiscal-quarter numbers vary by
    # company calendar and are deliberately not computed.
    period_end: str
    revenue: float | None = None
    net_income: float | None = None


class FinancialsResponse(BaseModel):
    cik: str
    years: list[AnnualFinancials]
    quarters: list[QuarterlyFinancials] = []


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
    created_at: str


class AnalysisListResponse(BaseModel):
    analyses: list[AnalysisResponse]
    total: int


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

    state: Literal["indexing", "complete", "unavailable"]
    chunks_indexed: int
    chunks_total: int
