"""The backfill script itself hits real EDGAR/Gemini and is never run in CI —
these cover the logic that decides *what* it would touch."""

from app.models.schemas import Filing
from app.services import database, edgar, embeddings
from scripts.backfill_chunks import _load_candidates, _resolve_primary_document, backfill


FILINGS = [
    Filing(
        accession_number="0000320193-25-000057",
        form_type="10-Q",
        filing_date="2025-05-02",
        primary_document="aapl-q2.htm",
    ),
    Filing(
        accession_number="0000320193-24-000123",
        form_type="10-K",
        filing_date="2024-11-01",
        primary_document="aapl-10k.htm",
    ),
]


# --- accession matching ---

def test_resolves_dashless_stored_accession_against_edgars_dashed_one():
    assert _resolve_primary_document("000032019325000057", FILINGS) == "aapl-q2.htm"
    assert _resolve_primary_document("000032019324000123", FILINGS) == "aapl-10k.htm"


def test_unknown_accession_resolves_to_none():
    assert _resolve_primary_document("999999999999999999", FILINGS) is None


# --- candidate selection ---

def _rows(stored_analysis_row, count):
    return [
        stored_analysis_row.model_copy(update={"id": i, "accession_number": f"acc{i}"})
        for i in range(count)
    ]


async def test_partially_indexed_filings_are_still_candidates(monkeypatch, stored_analysis_row):
    """The inline indexer leaves large filings partial — those need topping up,
    so completeness is decided per filing once the text is in hand, not here."""
    rows = _rows(stored_analysis_row, 3)

    async def list_page(limit, offset, ticker):
        return (rows, len(rows)) if offset == 0 else ([], len(rows))

    monkeypatch.setattr(database, "list_analyses", list_page)

    candidates = await _load_candidates(None, None)
    assert [c.accession_number for c in candidates] == ["acc0", "acc1", "acc2"]


async def test_limit_stops_collecting_early(monkeypatch, stored_analysis_row):
    rows = _rows(stored_analysis_row, 5)

    async def list_page(limit, offset, ticker):
        return (rows, len(rows)) if offset == 0 else ([], len(rows))

    monkeypatch.setattr(database, "list_analyses", list_page)

    assert len(await _load_candidates(None, 2)) == 2


async def test_a_fully_indexed_filing_spends_no_embedding_quota(
    monkeypatch, stored_analysis_row
):
    async def list_page(limit, offset, ticker):
        return ([stored_analysis_row], 1) if offset == 0 else ([], 1)

    async def get_filings(cik, form_types, limit):
        return [
            Filing(
                accession_number=stored_analysis_row.accession_number,
                form_type="10-Q",
                filing_date="2025-05-02",
                primary_document="aapl-q2.htm",
            )
        ]

    async def fetch_text(cik, accession_number, primary_document):
        return "x" * 5000  # 3 chunks

    async def already_complete(accession):
        return 3

    async def fail(*args, **kwargs):
        raise AssertionError("a complete filing must not be re-embedded")

    monkeypatch.setattr(database, "list_analyses", list_page)
    monkeypatch.setattr(database, "chunk_count", already_complete)
    monkeypatch.setattr(edgar, "get_filings", get_filings)
    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_text)
    monkeypatch.setattr(embeddings, "index_filing", fail)

    assert await backfill(None, None, sleep=0, dry_run=False) == 0


# --- the run loop ---

async def test_dry_run_spends_no_quota(monkeypatch, stored_analysis_row):
    async def list_page(limit, offset, ticker):
        return ([stored_analysis_row], 1) if offset == 0 else ([], 1)

    async def no_chunks(accession):
        return 0

    async def fail(*args, **kwargs):
        raise AssertionError("dry run must not touch EDGAR or Gemini")

    monkeypatch.setattr(database, "list_analyses", list_page)
    monkeypatch.setattr(database, "chunk_count", no_chunks)
    monkeypatch.setattr(edgar, "get_filings", fail)
    monkeypatch.setattr(embeddings, "index_filing", fail)

    assert await backfill(None, None, sleep=0, dry_run=True) == 0


async def test_one_filing_that_edgar_cannot_resolve_does_not_stop_the_run(
    monkeypatch, stored_analysis_row
):
    rows = _rows(stored_analysis_row, 2)
    indexed = []

    async def list_page(limit, offset, ticker):
        return (rows, len(rows)) if offset == 0 else ([], len(rows))

    async def no_chunks(accession):
        return 0

    async def get_filings(cik, form_types, limit):
        # Only the second row's accession is present in EDGAR's recent list
        return [
            Filing(
                accession_number="acc1",
                form_type="10-Q",
                filing_date="2025-05-02",
                primary_document="aapl-q2.htm",
            )
        ]

    async def fetch_text(cik, accession_number, primary_document):
        return "Total revenue was $1,000 million."

    async def index(accession_number, filing_text, *, pacer=None, resume=False):
        indexed.append(accession_number)
        return 1

    monkeypatch.setattr(database, "list_analyses", list_page)
    monkeypatch.setattr(database, "chunk_count", no_chunks)
    monkeypatch.setattr(edgar, "get_filings", get_filings)
    monkeypatch.setattr(edgar, "fetch_filing_text", fetch_text)
    monkeypatch.setattr(embeddings, "index_filing", index)

    exit_code = await backfill(None, None, sleep=0, dry_run=False)

    assert indexed == ["acc1"]  # acc0 skipped, acc1 still indexed
    assert exit_code == 1  # non-zero because one filing failed


async def test_nothing_to_do_is_a_clean_exit(monkeypatch, stored_analysis_row):
    async def empty(limit, offset, ticker):
        return [], 0

    monkeypatch.setattr(database, "list_analyses", empty)
    assert await backfill(None, None, sleep=0, dry_run=False) == 0
