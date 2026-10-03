"""Language drift (roadmap 12.1): GET /analysis/{id}/drift and the pure rules behind it.

The nearest-neighbour scan lives in SQL (filing_drift) and a mocked client cannot reach it. What
is verified here is the prior rule, the states, the threshold arithmetic, the boilerplate filter
and the cache; the SQL is verified against the live database (schema.sql's migration block)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.cache import drift_cache
from app.main import app
from app.models.schemas import AnalysisResponse
from app.services import database, drift, indexing
from app.services.indexing import IndexStatus


client = TestClient(app, raise_server_exceptions=False)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "prior_analysis.json").read_text()
)

PROSE = (
    "The Company entered into a new credit facility with a syndicate of lenders during the "
    "quarter, replacing its prior arrangement. Borrowings bear interest at a floating rate."
)
TABLE = "Net income 18,164 62,647 35,291 92,902 70,623 135,281 Adjustments 1,775 1,885 1,482"
SIGNATURE = "thereunto duly authorized. CAPITAL ONE FINANCIAL CORPORATION By: /s/ Andrew Young"


def analysis(accession, form_type="10-Q", filing_date="2026-07-31", id=1, expected=None):
    return AnalysisResponse(
        id=id,
        accession_number=accession,
        cik="320193",
        ticker="AAPL",
        company_name="Apple Inc.",
        form_type=form_type,
        filing_date=filing_date,
        risk_factors=[],
        chunks_expected=expected,
        created_at="2026-08-01T00:00:00+00:00",
    )


def from_fixture(row, id):
    return analysis(row["accession_number"], row["form_type"], row["filing_date"], id=id)


# --- the prior rule, pinned to the fixture the frontend shares ---

@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["why"])
def test_pick_prior_matches_the_shared_fixture(case):
    history = [from_fixture(row, i) for i, row in enumerate(FIXTURE["history"], 1)]
    subject = next(h for h in history if h.accession_number == case["subject"])

    prior = drift.pick_prior(subject, history)

    assert (prior.accession_number if prior else None) == case["prior"]


# --- pure helpers ---

def test_boilerplate_catches_tables_and_form_furniture_but_not_prose():
    assert drift.is_boilerplate(TABLE)
    assert drift.is_boilerplate(SIGNATURE)
    assert drift.is_boilerplate("(I.R.S. Employer Identification No.) 3421 Hillview Ave")
    assert not drift.is_boilerplate(PROSE)


def test_sentences_drop_the_window_fragments_and_keep_abbreviations():
    text = "ere cut mid-word. The Company relies on U.S. suppliers. Apple Inc. makes devices! Trailing frag"

    assert drift.sentences(text) == [
        "The Company relies on U.S. suppliers.",
        "Apple Inc. makes devices!",
    ]


def test_a_lowercase_trailing_fragment_does_not_take_the_last_sentence_with_it():
    assert drift.sentences("x. First whole sentence. Last whole sentence. and a frag") == [
        "First whole sentence.",
        "Last whole sentence.",
    ]


def test_a_chunk_that_opens_the_filing_keeps_its_first_sentence():
    assert drift.sentences("First line. Second line.", starts_clean=True) == [
        "First line.",
        "Second line.",
    ]


def test_excerpt_takes_whole_sentences_up_to_the_limit():
    parts = ["One two three.", "Four five six.", "Seven eight nine."]

    assert drift.excerpt(parts, limit=30) == "One two three. Four five six."


def test_excerpt_cuts_a_single_long_sentence_at_a_word():
    out = drift.excerpt(["alpha beta gamma delta epsilon."], limit=20)

    assert out == "alpha beta gamma…"


def test_join_chunks_splices_the_overlap_back_together():
    text = " ".join(f"Sentence number {i} is here." for i in range(40))
    chunks = [text[0:300], text[200:500], text[400:]]

    assert drift.join_chunks(chunks) == text


def test_compare_shows_the_changed_run_beside_its_earlier_wording():
    prior = (
        "Opening line. The Company relies on suppliers. In addition to intense competition for "
        "talent, workforce dynamics are constantly evolving. Closing line."
    )
    new = (
        "x. The Company relies on suppliers. In addition to competition for talent, workforce "
        "dynamics are constantly evolving and the Company must navigate changes effectively. "
        "Closing line. y"
    )

    result = drift.compare(new, prior)

    assert result == drift.Comparison(
        excerpt=(
            "In addition to competition for talent, workforce dynamics are constantly evolving "
            "and the Company must navigate changes effectively."
        ),
        prior_excerpt=(
            "In addition to intense competition for talent, workforce dynamics are constantly "
            "evolving."
        ),
    )


def test_compare_leaves_the_old_side_empty_when_nothing_is_close():
    # Shares the stock ending with the new sentence, and nothing else: no counterpart.
    prior = "Start. These and other factors could affect results of operations, financial condition and stock price. End."
    new = (
        "x. Component suppliers may fail or consolidate, limiting supply of custom parts, which "
        "could affect results of operations, financial condition and stock price. y"
    )

    result = drift.compare(new, prior)

    assert result is not None and result.prior_excerpt is None


def test_compare_matches_only_the_sentences_it_shows():
    long = "Word " * 95 + "end."
    prior = f"Start. {long} Second shown sentence about tariffs and duties. End."
    new = f"x. {long.replace('end.', 'finish.')} Second shown sentence about tariffs and duties changed now. y"

    result = drift.compare(new, prior)

    # The first sentence fills the excerpt alone, so the second's near-copy in the prior filing
    # must not appear as the old side.
    assert result is not None
    assert "tariffs" not in result.excerpt
    assert result.prior_excerpt is None or "tariffs" not in result.prior_excerpt


def test_compare_treats_moved_text_as_carried_over():
    prior = "Start. Risk section text. Later, a sentence that moved elsewhere in the filing. End."
    new = "x. Later, a sentence that moved elsewhere in the filing. y"

    assert drift.compare(new, prior) is None


def test_novel_indexes_are_below_threshold_lowest_first():
    rows = [
        {"chunk_index": 0, "max_similarity": 0.99},
        {"chunk_index": 1, "max_similarity": 0.88},
        {"chunk_index": 2, "max_similarity": 0.85},
        {"chunk_index": 3, "max_similarity": drift.NOVEL_THRESHOLD},
    ]

    assert drift.novel_indexes(rows) == [2, 1]


# --- the wrappers ---

class FakeClient:
    def __init__(self, data):
        self.data = data
        self.calls: list[tuple] = []

    def rpc(self, name, params):
        self.calls.append(("rpc", name, params))
        return self

    def table(self, name):
        self.calls.append(("table", name))
        return self

    def select(self, cols):
        return self

    def eq(self, col, value):
        self.calls.append(("eq", col, value))
        return self

    def in_(self, col, values):
        self.calls.append(("in", col, values))
        return self

    def execute(self):
        return type("Result", (), {"data": self.data})()


@pytest.mark.asyncio
async def test_filing_drift_sends_both_accessions(monkeypatch):
    fake = FakeClient(None)
    monkeypatch.setattr(database, "_get_client", lambda: fake)

    assert await database.filing_drift("NEW", "OLD") == []
    assert fake.calls == [("rpc", "filing_drift", {"p_new": "NEW", "p_old": "OLD"})]


@pytest.mark.asyncio
async def test_chunk_contents_reads_only_the_named_chunks(monkeypatch):
    fake = FakeClient([{"chunk_index": 4, "content": "text"}])
    monkeypatch.setattr(database, "_get_client", lambda: fake)

    assert await database.chunk_contents("NEW", [4]) == {4: "text"}
    assert ("in", "chunk_index", [4]) in fake.calls


@pytest.mark.asyncio
async def test_chunk_contents_skips_the_read_when_nothing_is_named(monkeypatch):
    def boom():
        raise AssertionError("no read expected")

    monkeypatch.setattr(database, "_get_client", boom)

    assert await database.chunk_contents("NEW", []) == {}


# --- the endpoint ---

SUBJECT = analysis("NEW", expected=10)
PRIOR = analysis("OLD", filing_date="2026-05-01", id=2, expected=10)


@pytest.fixture
def stored(monkeypatch):
    """Subject and prior both stored and fully indexed; tests override pieces."""
    state = {
        "history": [SUBJECT, PRIOR],
        "status": indexing.COMPLETE,
        "rows": [{"chunk_index": i, "max_similarity": 0.97} for i in range(10)],
        "contents": {},
        "prior_chunks": ["Opening line. Nothing in common here. Closing line."],
        "prior_reads": 0,
        "rpc_calls": 0,
    }

    async def by_id(analysis_id):
        return SUBJECT if analysis_id == 1 else None

    async def list_analyses(limit=20, offset=0, ticker=None, sic=None, owner_org=None):
        return state["history"], len(state["history"])

    async def status_for(accession_number, chunks_expected=None):
        return IndexStatus(state["status"], 10, 10)

    async def filing_drift(new, old):
        state["rpc_calls"] += 1
        return state["rows"]

    async def chunk_contents(accession, indexes):
        return {i: state["contents"][i] for i in indexes if i in state["contents"]}

    async def all_chunk_contents(accession):
        state["prior_reads"] += 1
        return state["prior_chunks"]

    monkeypatch.setattr(database, "get_by_id", by_id)
    monkeypatch.setattr(database, "list_analyses", list_analyses)
    monkeypatch.setattr(indexing, "status_for", status_for)
    monkeypatch.setattr(database, "filing_drift", filing_drift)
    monkeypatch.setattr(database, "chunk_contents", chunk_contents)
    monkeypatch.setattr(database, "all_chunk_contents", all_chunk_contents)
    return state


def test_drift_404s_for_an_unknown_analysis(stored):
    assert client.get("/api/analysis/99/drift").status_code == 404


def test_drift_without_a_same_form_prior_is_no_prior(stored):
    stored["history"] = [SUBJECT, analysis("K", form_type="10-K", filing_date="2026-01-01")]

    body = client.get("/api/analysis/1/drift").json()

    assert body["state"] == "no_prior"
    assert body["prior_analysis_id"] is None
    assert stored["rpc_calls"] == 0


def test_drift_against_a_partial_index_is_not_indexed(stored):
    stored["status"] = indexing.PARTIAL

    body = client.get("/api/analysis/1/drift").json()

    assert body["state"] == "not_indexed"
    assert body["prior_analysis_id"] == 2
    assert body["prior_filing_date"] == "2026-05-01"
    assert stored["rpc_calls"] == 0


def test_drift_counts_carried_over_prose_and_skips_boilerplate(stored):
    stored["rows"][3] = {"chunk_index": 3, "max_similarity": 0.85}
    stored["rows"][7] = {"chunk_index": 7, "max_similarity": 0.88}
    stored["rows"][9] = {"chunk_index": 9, "max_similarity": 0.80}
    stored["contents"] = {3: PROSE, 7: PROSE, 9: TABLE}

    response = client.get("/api/analysis/1/drift")
    body = response.json()

    assert response.status_code == 200
    assert body["state"] == "ok"
    # The table leaves the denominator: 7 of the 9 remaining passages carried over.
    assert body["carried_over"] == pytest.approx(7 / 9)
    assert [p["chunk_index"] for p in body["novel_passages"]] == [3, 7]
    # PROSE opens mid-window, so its first sentence is dropped as a fragment.
    assert body["novel_passages"][0]["excerpt"] == "Borrowings bear interest at a floating rate."
    assert body["novel_passages"][0]["prior_excerpt"] is None
    assert body["mean_similarity"] == pytest.approx((7 * 0.97 + 0.85 + 0.88 + 0.80) / 10)
    assert "x-ratelimit-limit" in response.headers


def test_drift_caps_the_novel_passages(stored):
    stored["rows"] = [{"chunk_index": i, "max_similarity": 0.5 + i / 100} for i in range(10)]
    stored["contents"] = {i: PROSE for i in range(10)}

    body = client.get("/api/analysis/1/drift").json()

    assert [p["chunk_index"] for p in body["novel_passages"]] == [0, 1, 2, 3, 4]
    assert body["carried_over"] == 0


def test_drift_pairs_a_passage_with_its_earlier_wording(stored):
    stored["rows"][3] = {"chunk_index": 3, "max_similarity": 0.85}
    stored["contents"] = {
        3: "x. Borrowings bear interest at a floating rate tied to SOFR plus a margin. y"
    }
    stored["prior_chunks"] = ["Start. Borrowings bear interest at a floating rate. End."]

    passage = client.get("/api/analysis/1/drift").json()["novel_passages"][0]

    assert passage["excerpt"] == "Borrowings bear interest at a floating rate tied to SOFR plus a margin."
    assert passage["prior_excerpt"] == "Borrowings bear interest at a floating rate."


def test_drift_skips_a_passage_whose_sentences_all_moved_from_the_prior(stored):
    stored["rows"][3] = {"chunk_index": 3, "max_similarity": 0.85}
    stored["contents"] = {3: PROSE}
    stored["prior_chunks"] = [f"Start. {PROSE} End."]

    body = client.get("/api/analysis/1/drift").json()

    assert body["novel_passages"] == []
    # The share is still the embedding measure: the passage scored under the threshold.
    assert body["carried_over"] == pytest.approx(9 / 10)


def test_drift_reads_the_prior_text_only_when_a_passage_needs_it(stored):
    body = client.get("/api/analysis/1/drift").json()

    assert body["novel_passages"] == []
    assert stored["prior_reads"] == 0


def test_drift_caches_a_complete_result(stored):
    client.get("/api/analysis/1/drift")
    client.get("/api/analysis/1/drift")

    assert stored["rpc_calls"] == 1
    assert drift_cache.get("NEW:OLD") is not None


def test_drift_does_not_cache_a_not_indexed_answer(stored):
    stored["status"] = indexing.INDEXING
    client.get("/api/analysis/1/drift")
    stored["status"] = indexing.COMPLETE

    body = client.get("/api/analysis/1/drift").json()

    assert body["state"] == "ok"
    assert stored["rpc_calls"] == 1
