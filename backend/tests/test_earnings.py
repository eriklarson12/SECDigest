"""Earnings-release summaries (roadmap 15.3): exhibit lookup, the quote filter, and the routes."""

from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.cache import earnings_cache
from app.config import settings
from app.main import app
from app.models.schemas import EarningsExtraction, EarningsFigure, EarningsSummary
from app.routers import companies as companies_router
from app.services import database
from app.services.earnings import MAX_FIGURES, keep_supported, release_document
from app.services.llm import LLMError

client = TestClient(app, raise_server_exceptions=False)

FIXTURES = Path(__file__).parent / "fixtures" / "earnings"
ACCESSION = "0000320193-26-000024"
DASHLESS = ACCESSION.replace("-", "")
OTHER_8K = "0000320193-26-000020"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0000320193.json"
FOLDER = f"https://www.sec.gov/Archives/edgar/data/320193/{DASHLESS}/"
HEADERS_URL = f"{FOLDER}{ACCESSION}-index-headers.html"
RELEASE_URL = FOLDER + "a8-kex991q4202609262026.htm"
POST_URL = f"/api/companies/320193/earnings/{ACCESSION}"

# The `&nbsp;` is the measured trap: it becomes `\xa0`, and the model quotes a plain space.
RELEASE_HTML = """<html><body>
<p>The Company posted quarterly revenue of $114.5&nbsp;billion, up 12 percent year over year.</p>
<p>Diluted earnings per share was $2.10, up 14 percent year over year.</p>
</body></html>"""
RELEASE_TEXT = "The Company posted quarterly revenue of $114.5\xa0billion, up 12 percent year over year."


def headers(name: str) -> str:
    return (FIXTURES / f"{name}-index-headers.html").read_text()


def figure(value: str, quote: str, label: str = "Revenue") -> EarningsFigure:
    return EarningsFigure(label=label, value=value, period="Q4 2026", quote=quote)


# --- release_document ---

def test_the_release_is_the_ex_99_1_file():
    assert release_document(headers("aapl")) == "a8-kex991q4202609262026.htm"


def test_a_second_exhibit_is_never_the_release():
    # JPM files its narrative as EX-99.1 and an 89k-character supplement as EX-99.2.
    assert release_document(headers("jpm")) == "a3q26erfexhibit991narrative.htm"


def test_no_ex_99_1_is_none():
    assert release_document(headers("aapl").replace("EX-99.1", "EX-99.3")) is None


@pytest.mark.parametrize("name", ["../x.htm", "a/b.htm", ".htm", "release.pdf"])
def test_a_file_name_that_could_leave_the_folder_is_refused(name):
    page = "<TYPE>EX-99.1\n<SEQUENCE>2\n<FILENAME>" + name + "\n"
    assert release_document(page) is None


# --- keep_supported ---

def test_a_quote_that_differs_only_by_a_non_breaking_space_is_kept():
    kept = keep_supported([figure("$114.5 billion", "quarterly revenue of $114.5 billion")], RELEASE_TEXT)
    assert len(kept) == 1


def test_a_paraphrased_quote_is_dropped():
    assert keep_supported([figure("$114.5 billion", "Revenue rose to $114.5 billion")], RELEASE_TEXT) == []


def test_a_verbatim_quote_about_another_number_is_dropped():
    assert keep_supported([figure("$115.0 billion", "quarterly revenue of $114.5 billion")], RELEASE_TEXT) == []


def test_a_number_with_thousands_separators_matches_either_way():
    text = "Net revenue was $1,234.5 million for the quarter."
    assert len(keep_supported([figure("$1234.5 million", "Net revenue was $1,234.5 million")], text)) == 1


def test_at_most_eight_figures_are_kept():
    many = [figure("$114.5 billion", "quarterly revenue of $114.5 billion")] * (MAX_FIGURES + 2)
    assert len(keep_supported(many, RELEASE_TEXT)) == MAX_FIGURES


# --- routes ---

def feed() -> dict:
    return {
        "filings": {
            "recent": {
                "form": ["8-K", "8-K", "10-Q"],
                "accessionNumber": [ACCESSION, OTHER_8K, "0000320193-26-000010"],
                "filingDate": ["2026-11-02", "2026-10-01", "2026-08-01"],
                "primaryDocument": ["aapl-20261102.htm", "aapl-20261001.htm", "aapl-10q.htm"],
                "primaryDocDescription": ["", "", ""],
                "items": ["2.02,9.01", "5.02", ""],
            }
        }
    }


def mock_edgar() -> None:
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(200, json=feed()))
    respx.get(HEADERS_URL).mock(return_value=httpx.Response(200, text=headers("aapl")))
    respx.get(RELEASE_URL).mock(return_value=httpx.Response(200, text=RELEASE_HTML))


def stored(**overrides) -> EarningsSummary:
    data = {
        "accession_number": DASHLESS,
        "cik": "320193",
        "document": "a8-kex991q4202609262026.htm",
        "summary": "Revenue grew. EPS grew.",
        "figures": [],
        "model": "gemini-3.6-flash",
        "created_at": "2026-11-04T12:00:00+00:00",
    } | overrides
    return EarningsSummary.model_validate(data)


@pytest.fixture
def pipeline(monkeypatch):
    calls: dict = {"llm": 0, "stored": None}

    async def not_stored(accession_number):
        return None

    async def summarize(text):
        calls["llm"] += 1
        calls["text"] = text
        return (
            EarningsExtraction(
                summary="Apple posted record revenue. EPS rose 14 percent.",
                figures=[
                    figure("$114.5 billion", "quarterly revenue of $114.5 billion"),
                    figure("$2.10", "Diluted earnings per share was $2.10", label="Diluted EPS"),
                    figure("$114.5 billion", "Revenue rose to $114.5 billion", label="Paraphrased"),
                ],
            ),
            "gemini-3.6-flash",
        )

    async def create(data):
        calls["stored"] = data
        return stored(**data)

    monkeypatch.setattr(database, "get_earnings_summary", not_stored)
    monkeypatch.setattr(companies_router, "summarize_earnings", summarize)
    monkeypatch.setattr(database, "create_earnings_summary", create)
    return calls


@respx.mock
def test_a_cold_summary_reads_three_documents_and_stores_only_supported_figures(pipeline):
    mock_edgar()
    response = client.post(POST_URL)
    assert response.status_code == 200
    assert len(respx.calls) == 3
    assert pipeline["llm"] == 1
    assert "\xa0" in pipeline["text"]
    stored_row = pipeline["stored"]
    assert stored_row["accession_number"] == DASHLESS
    assert stored_row["cik"] == "320193"
    assert stored_row["document"] == "a8-kex991q4202609262026.htm"
    assert [f["label"] for f in stored_row["figures"]] == ["Revenue", "Diluted EPS"]
    assert response.json()["figures"][1]["value"] == "$2.10"


@respx.mock
def test_a_stored_summary_costs_no_edgar_request_and_no_llm_call(monkeypatch, pipeline):
    async def hit(accession_number):
        return stored()

    monkeypatch.setattr(database, "get_earnings_summary", hit)
    response = client.post(POST_URL)
    assert response.status_code == 200
    assert response.json()["summary"] == "Revenue grew. EPS grew."
    assert len(respx.calls) == 0
    assert pipeline["llm"] == 0


@respx.mock
@pytest.mark.parametrize("accession", [OTHER_8K, "0000320193-26-000099"])
def test_an_accession_that_is_not_a_recent_2_02_8k_is_404_before_any_quota(
    monkeypatch, pipeline, accession
):
    monkeypatch.setattr(settings, "daily_analysis_cap", 0)
    mock_edgar()
    response = client.post(f"/api/companies/320193/earnings/{accession}")
    assert response.status_code == 404
    assert response.json()["detail"] == "Not an earnings release in this company's recent filings"
    assert pipeline["llm"] == 0


@respx.mock
def test_a_filing_without_ex_99_1_is_404(pipeline):
    mock_edgar()
    respx.get(HEADERS_URL).mock(
        return_value=httpx.Response(200, text=headers("aapl").replace("EX-99.1", "EX-99.3"))
    )
    response = client.post(POST_URL)
    assert response.status_code == 404
    assert response.json()["detail"] == "No earnings release exhibit in this filing"
    assert pipeline["llm"] == 0


@pytest.mark.parametrize(
    "url",
    [
        f"/api/companies/abc/earnings/{ACCESSION}",
        "/api/companies/320193/earnings/not-an-accession",
    ],
)
def test_a_malformed_cik_or_accession_is_422(url):
    assert client.post(url).status_code == 422


@respx.mock
def test_quota_exhaustion_is_503_with_retry_after_and_no_llm_call(monkeypatch, pipeline):
    monkeypatch.setattr(settings, "daily_analysis_cap", 0)
    mock_edgar()
    response = client.post(POST_URL)
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "3600"
    assert pipeline["llm"] == 0


@respx.mock
def test_an_llm_failure_is_502_and_stores_nothing(monkeypatch, pipeline):
    async def fail(text):
        raise LLMError("boom")

    monkeypatch.setattr(companies_router, "summarize_earnings", fail)
    mock_edgar()
    assert client.post(POST_URL).status_code == 502
    assert pipeline["stored"] is None


@respx.mock
def test_an_edgar_failure_is_502(pipeline):
    respx.get(SUBMISSIONS_URL).mock(return_value=httpx.Response(503))
    assert client.post(POST_URL).status_code == 502
    assert pipeline["llm"] == 0


def test_the_list_is_served_from_cache_after_the_first_read(monkeypatch):
    reads = []

    def read(cik):
        reads.append(cik)
        return [stored()]

    monkeypatch.setattr(database, "_list_earnings_summaries_sync", read)
    first = client.get("/api/companies/0000320193/earnings")
    second = client.get("/api/companies/320193/earnings")
    assert first.status_code == second.status_code == 200
    assert first.json()[0]["accession_number"] == DASHLESS
    assert reads == ["320193"]


def test_a_list_failure_is_502(monkeypatch):
    def fail(cik):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(database, "_list_earnings_summaries_sync", fail)
    assert client.get("/api/companies/320193/earnings").status_code == 502


def test_storing_a_summary_drops_the_company_list_from_cache(monkeypatch):
    class Query:
        def insert(self, data):
            self.data = [data | {"created_at": "2026-11-04T12:00:00+00:00"}]
            return self

        def execute(self):
            return self

    class Client:
        def table(self, name):
            assert name == "earnings_summaries"
            return Query()

    monkeypatch.setattr(database, "_get_client", lambda: Client())
    earnings_cache.set("320193", [])
    earnings_cache.set("789019", [])
    database._create_earnings_summary_sync(
        stored().model_dump(exclude={"created_at"}) | {"figures": []}
    )
    assert earnings_cache.get("320193") is None
    assert earnings_cache.get("789019") == []
