"""`build-corpus` and `check-golden`: what they spend, and what they refuse before spending it."""

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from evals import eval_qa
from evals.eval_qa import CorpusChunk, FilingCorpus
from evals.qa_scoring import GoldenQuestion
from evals.scoring import GoldenEntry

SIZE = 1500


def _entry(accession: str) -> GoldenEntry:
    return GoldenEntry(
        ticker="AAPL", cik="320193", company_name="Apple Inc.", accession_number=accession,
        primary_document="a.htm", fiscal_year=2025,
    )


FILING_Q = GoldenQuestion(accession_number="a", ticker="AAPL", question="Q?", expect_substring="alpha")
COMPANY_Q = GoldenQuestion(
    accession_number="a", ticker="AAPL", question="Q?", scope="company",
    accession_numbers=["a", "b"], expect_substrings=["alpha", "beta"],
)


@dataclass
class Env:
    dir: Path
    embedded: list[list[str]] = field(default_factory=list)
    # What embeddings_remaining answers, one value per call; the last one repeats.
    remaining: list[int] = field(default_factory=lambda: [10_000])


@pytest.fixture
def corpus_env(monkeypatch, tmp_path):
    """Every network edge stubbed; `embedded` records each batch embed_texts was asked for."""
    env = Env(tmp_path)

    async def fake_label(_entry):
        return "10-K", "2025-10-31"

    async def fake_fetch(*_args):
        return "filing text"

    async def fake_embed(texts, _task, **_kwargs):
        env.embedded.append(list(texts))
        return [[1.0] for _ in texts]

    async def fake_remaining():
        return env.remaining.pop(0) if len(env.remaining) > 1 else env.remaining[0]

    monkeypatch.setattr(eval_qa, "_CORPUS_DIR", tmp_path)
    monkeypatch.setattr(eval_qa, "load_questions", lambda: [FILING_Q, COMPANY_Q])
    monkeypatch.setattr(eval_qa, "load_filings", lambda: [_entry("a"), _entry("b")])
    monkeypatch.setattr(eval_qa, "_filing_label", fake_label)
    monkeypatch.setattr(eval_qa.edgar, "fetch_filing_text", fake_fetch)
    monkeypatch.setattr(eval_qa.embeddings, "embed_texts", fake_embed)
    monkeypatch.setattr(eval_qa.embeddings, "plan_batches", lambda texts: [texts[i : i + 2] for i in range(0, len(texts), 2)])
    monkeypatch.setattr(eval_qa.quota, "embeddings_remaining", fake_remaining)
    monkeypatch.setattr(eval_qa, "chunk_text", lambda _text, size: ["alpha one", "beta two", "gamma", "delta"])
    return env


def _saved(env: Env, accession: str) -> FilingCorpus:
    return FilingCorpus.model_validate_json((env.dir / str(SIZE) / f"{accession}.json").read_text())


async def test_filing_scope_builds_only_the_filings_filing_questions_read(corpus_env):
    """`--ticker AAPL` alone would also build the prior-year 10-K only a company question reads."""
    assert await eval_qa.build_corpus(None, False, SIZE, scope="filing") == 0
    assert _saved(corpus_env, "a").complete
    assert not (corpus_env.dir / str(SIZE) / "b.json").exists()


async def test_a_label_split_by_the_chunking_stops_the_build_before_any_embedding(corpus_env, monkeypatch, caplog):
    monkeypatch.setattr(eval_qa, "chunk_text", lambda _text, size: ["the alp", "ha and more"])
    with caplog.at_level("ERROR"):
        assert await eval_qa.build_corpus(None, False, SIZE, scope="filing") == 2
    assert corpus_env.embedded == []
    assert "'alpha' is in no chunk of a" in caplog.text


async def test_the_build_stops_before_the_batch_that_would_eat_the_reserve_and_then_resumes(corpus_env):
    corpus_env.remaining = [203, 201]
    assert await eval_qa.build_corpus(None, False, SIZE, scope="filing", keep=200) == 1
    partial = _saved(corpus_env, "a")
    assert [c.content for c in partial.chunks] == ["alpha one", "beta two"]
    assert partial.total_chunks == 4

    corpus_env.remaining = [10_000]
    assert await eval_qa.build_corpus(None, False, SIZE, scope="filing", keep=200) == 0
    assert corpus_env.embedded[-1] == ["gamma", "delta"]
    assert [c.chunk_index for c in _saved(corpus_env, "a").chunks] == [0, 1, 2, 3]


async def test_an_unreadable_quota_table_stops_the_build_too(corpus_env):
    """embeddings_remaining reads 0 when it cannot reach the table, which must not read as room to spend."""
    corpus_env.remaining = [0]
    assert await eval_qa.build_corpus(None, False, SIZE, scope="filing") == 1
    assert corpus_env.embedded == []


def _write_corpus(env: Env, accession: str, *contents: str) -> None:
    corpus = FilingCorpus(
        accession_number=accession, ticker="AAPL", chunk_size=SIZE, chunk_overlap=eval_qa.CHUNK_OVERLAP,
        embed_model="gemini-embedding-001", total_chunks=len(contents),
        chunks=[CorpusChunk(chunk_index=i, content=c, embedding=[1.0]) for i, c in enumerate(contents)],
    )
    (env.dir / str(SIZE)).mkdir(exist_ok=True)
    (env.dir / str(SIZE) / f"{accession}.json").write_text(corpus.model_dump_json())


def test_check_golden_at_filing_scope_needs_no_company_only_corpus(corpus_env):
    _write_corpus(corpus_env, "a", "alpha one")
    assert eval_qa.check_golden(SIZE, scope="filing") == 0
    with pytest.raises(FileNotFoundError):
        eval_qa.check_golden(SIZE)


def test_check_golden_still_reports_a_label_no_chunk_holds(corpus_env, caplog):
    _write_corpus(corpus_env, "a", "omega")
    with caplog.at_level("ERROR"):
        assert eval_qa.check_golden(SIZE, scope="filing") == 2
    assert "'alpha' is in no chunk of a" in caplog.text
