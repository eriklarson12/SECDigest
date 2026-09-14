"""The Q&A eval's `run` needs a built corpus and real Gemini quota, never run in CI — these cover the pure metrics that decide what it reports.
`evals/qa_scoring.py` reaches nothing outside its arguments, which is what lets the whole gate run in the normal pytest suite."""

import json
from typing import Literal

import pytest

from evals import qa_scoring
from evals.qa_scoring import (
    QAArtifact,
    QARecord,
    RetrievedChunk,
    classify_figures,
    extract_figures,
    flatten,
    is_refusal,
    score_record,
    totals,
)


def _chunks(*contents: str) -> list[RetrievedChunk]:
    return [
        RetrievedChunk(chunk_index=i, similarity=0.9 - i / 100, content=c)
        for i, c in enumerate(contents)
    ]


def _support(answer, chunks, question="How did revenue change?", scale="In millions."):
    return {f.raw: f.support for f in classify_figures(answer, chunks, question, scale)}


# --- figure normalization: the part that carries the risk ---

def test_thousands_separators_and_currency_are_not_part_of_the_number():
    assert _support("Revenue was $11,133.", _chunks("Total revenue 11133")) == {
        "$11,133": "verbatim"
    }


def test_a_scale_word_expands_against_a_filing_that_prints_the_bare_figure():
    """"$11.1 billion" and a millions-scaled "11,100" are the same claim."""
    assert _support("Revenue was $11.1 billion.", _chunks("Total revenue 11,100")) == {
        "$11.1 billion": "verbatim"
    }


def test_a_figure_is_grounded_only_once_the_unit_scale_is_applied():
    answer = "Revenue was $11,133 million."
    chunks = _chunks("Total revenue 11,133")
    assert _support(answer, chunks, scale="In millions.")["$11,133 million"] == "verbatim"


def test_a_figure_echoed_from_the_question_is_not_scored():
    """Repeating the asker's own number is not a claim about the filing."""
    scored = _support(
        "Yes, revenue reached 416,161.",
        _chunks("unrelated prose with no figures"),
        question="Did revenue reach 416,161?",
    )
    assert scored == {}


def test_a_year_is_not_treated_as_a_financial_figure():
    assert _support("Revenue grew in 2025.", _chunks("no numbers here")) == {}


def test_an_answer_with_no_figures_is_grounded():
    record = QARecord(
        accession_number="x", ticker="AAPL", question="What are the segments?",
        answer="The Company reports on a geographic basis.", chunks=_chunks("prose"),
    )
    assert score_record(record).grounded


def test_a_yoy_percentage_derived_from_two_grounded_figures_is_computed():
    """Deriving a change from two quoted figures is the model doing its job, not inventing."""
    scored = _support(
        "Revenue was $416,161 million, up 6.4% from $391,035 million.",
        _chunks("Total net sales 416,161 391,035"),
    )
    assert scored["6.4%"] == "computed"
    assert scored["$416,161 million"] == "verbatim"


def test_a_percentage_that_is_not_derivable_is_unsupported():
    scored = _support(
        "Revenue was $416,161 million, up 42.0%.",
        _chunks("Total net sales 416,161 391,035"),
    )
    assert scored["42.0%"] == "unsupported"


def test_an_invented_figure_is_unsupported():
    scored = _support(
        "Revenue was $416,161 million and R&D was $88,999 million.",
        _chunks("Total net sales 416,161"),
    )
    assert scored["$88,999 million"] == "unsupported"


def test_extract_figures_records_every_magnitude_a_literal_could_denote():
    [figure] = extract_figures("$11.1 billion")
    assert figure.candidates == [11.1, 11_100_000_000.0]


# --- refusal ---

@pytest.mark.parametrize(
    "answer,refused",
    [
        ("The narrative sections don't state the CEO's home address.", True),
        ("The excerpts do not disclose that figure.", True),
        ("That information is not available in the excerpts provided.", True),
        ("The CEO lives at 1 Infinite Loop, Cupertino, California.", False),
        ("Revenue is expected to reach $900 billion by 2030.", False),
    ],
)
def test_refusal_detection(answer, refused):
    assert is_refusal(answer) is refused


def test_a_refusal_that_still_invents_a_figure_does_not_count_as_refused():
    """Declining while making up a number is the failure the metric exists to catch."""
    record = QARecord(
        accession_number="x", ticker="MSFT", kind="unanswerable",
        question="What will revenue be in 2030?",
        answer="The filing does not state this, but revenue should reach $900,000 million.",
        chunks=_chunks("Total revenue 281,724"),
    )
    result = totals([score_record(record)])
    assert result.unanswerable == 1
    assert result.refused == 0


# --- retrieval labels ---

def test_a_label_matches_across_non_breaking_spaces_and_line_breaks():
    """EDGAR text keeps the source document's whitespace; a label typed with plain spaces still quotes the same sentence."""
    record = QARecord(
        accession_number="x", ticker="TGT", question="When does the fiscal year end?",
        expect_substring="fiscal year ends on the Saturday nearest January 31",
        answer="It ends on the Saturday nearest January 31.",
        chunks=_chunks("Our fiscal year ends on the\nSaturday nearest January\xa031."),
    )
    score = score_record(record)
    assert score.hit_at_1 and score.hit_at_k


def test_hit_at_1_is_false_when_the_label_is_only_in_a_later_chunk():
    record = QARecord(
        accession_number="x", ticker="AAPL", question="What are the segments?",
        expect_substring="Greater China",
        answer="Five geographic segments.", chunks=_chunks("nothing here", "Greater China"),
    )
    score = score_record(record)
    assert score.hit_at_1 is False
    assert score.hit_at_k is True


def test_flatten_collapses_every_kind_of_whitespace():
    assert flatten("A\xa0B\n C") == "a b c"


# --- citation precision ---

def test_a_source_the_answer_never_drew_on_is_not_counted_as_used():
    record = QARecord(
        accession_number="x", ticker="AAPL", question="What was revenue?",
        answer="Total net sales were $416,161 million.",
        chunks=_chunks("Total net sales 416,161", "An unrelated paragraph about leases."),
    )
    score = score_record(record)
    assert score.sources_used == 1
    assert score.sources_total == 2


# --- the gate ---

_FLOORS = {"min_accuracy": 1.0, "qa_min_grounded_rate": 1.0, "qa_min_refusal_rate": 1.0}


@pytest.fixture
def gate_env(monkeypatch, tmp_path):
    """Point the harness at a temp results dir and gate file.
    `load_corpus` is replaced by a failure: scoring reads only the artifact, so reaching the corpus at all is the bug."""
    from evals import eval_qa

    (tmp_path / "qa_results").mkdir()
    monkeypatch.setattr(eval_qa, "_RESULTS_DIR", tmp_path / "qa_results")
    monkeypatch.setattr(eval_qa, "_GATE_PATH", tmp_path / "gate.json")

    def unreachable(*_args, **_kwargs):
        raise AssertionError("scoring must not need the corpus")

    monkeypatch.setattr(eval_qa, "load_corpus", unreachable)
    (tmp_path / "gate.json").write_text(json.dumps(_FLOORS))
    return eval_qa


def _record(
    kind: Literal["answerable", "unanswerable"] = "answerable",
    answer="Revenue was $416,161 million.",
    **kwargs,
):
    return QARecord(
        accession_number="0000320193-25-000079",
        ticker="AAPL",
        question=kwargs.pop("question", "What was revenue?"),
        kind=kind,
        answer=answer,
        chunks=_chunks("Total net sales 416,161"),
        **kwargs,
    )


def _save_run(env, name, records):
    artifact = QAArtifact(
        run_date=name.removesuffix(".json"),
        model="gemini-3.5-flash-lite",
        retrieval_k=6,
        chunk_size=2000,
        refusal_markers=qa_scoring.REFUSAL_MARKERS,
        records=records,
    )
    (env._RESULTS_DIR / name).write_text(artifact.model_dump_json())


_REFUSED = _record(
    kind="unanswerable",
    question="What is the CEO's home address?",
    answer="The excerpts do not state the CEO's home address.",
)


def test_gate_passes_a_clean_run(gate_env):
    _save_run(gate_env, "2026-09-01.json", [_record(), _REFUSED])
    assert gate_env.score(results=None, baseline=None, write=False, gate=True) == 0


def test_gate_fails_an_answer_that_invents_a_figure(gate_env, caplog):
    _save_run(
        gate_env,
        "2026-09-01.json",
        [_record(answer="Revenue was $416,161 million and R&D was $88,999 million."), _REFUSED],
    )
    with caplog.at_level("ERROR"):
        code = gate_env.score(results=None, baseline=None, write=False, gate=True)
    assert code == 2
    assert "grounded rate" in caplog.text


def test_gate_fails_a_model_that_stops_refusing(gate_env):
    _save_run(
        gate_env,
        "2026-09-01.json",
        [
            _record(),
            _record(
                kind="unanswerable",
                question="What is the CEO's home address?",
                answer="The CEO lives at 1 Infinite Loop.",
            ),
        ],
    )
    assert gate_env.score(results=None, baseline=None, write=False, gate=True) == 2


def test_gate_without_an_earlier_run_skips_the_regression_check(gate_env, caplog):
    """Day one has exactly one artifact, so there is nothing to compare against. That must pass, not fail."""
    _save_run(gate_env, "2026-09-01.json", [_record(), _REFUSED])
    with caplog.at_level("INFO"):
        code = gate_env.score(results=None, baseline=None, write=False, gate=True)
    assert code == 0
    assert "regression check skipped" in caplog.text


def test_gate_fails_a_question_that_regressed_against_the_previous_run(gate_env, caplog):
    _save_run(gate_env, "2026-09-01.json", [_record(), _REFUSED])
    _save_run(
        gate_env,
        "2026-09-02.json",
        [_record(answer="Revenue was $999,999 million."), _REFUSED],
    )
    with caplog.at_level("ERROR"):
        code = gate_env.score(results=None, baseline=None, write=False, gate=True, min_grounded=0.0)
    assert code == 2
    assert "REGRESSION" in caplog.text


def test_floor_overrides_beat_the_committed_gate_file(gate_env):
    _save_run(
        gate_env,
        "2026-09-01.json",
        [_record(answer="Revenue was $416,161 million and R&D was $88,999 million."), _REFUSED],
    )
    code = gate_env.score(
        results=None, baseline=None, write=False, gate=True, min_grounded=0.0
    )
    assert code == 0


def test_an_artifact_with_no_questions_is_a_misconfiguration_not_a_gate_failure(gate_env):
    _save_run(gate_env, "2026-09-01.json", [])
    assert gate_env.score(results=None, baseline=None, write=False, gate=True) == 1


def test_no_artifacts_at_all_exits_one(gate_env):
    assert gate_env.score(results=None, baseline=None, write=False, gate=True) == 1


# --- local retrieval ---

def test_cosine_ignores_magnitude():
    """The stored vectors are MRL-truncated and never re-normalized, so a bare dot product would rank by length as much as by direction."""
    from evals.eval_qa import cosine

    assert cosine([1.0, 0.0], [5.0, 0.0]) == pytest.approx(1.0)
    assert cosine([1.0, 0.0], [0.0, 3.0]) == pytest.approx(0.0)


def test_top_chunks_ranks_by_direction_not_by_vector_length():
    from evals.eval_qa import FilingCorpus, CorpusChunk, top_chunks

    corpus = FilingCorpus(
        accession_number="x", ticker="AAPL", chunk_size=2000, chunk_overlap=200,
        embed_model="gemini-embedding-001",
        chunks=[
            CorpusChunk(chunk_index=0, content="far but long", embedding=[9.0, 9.0]),
            CorpusChunk(chunk_index=1, content="near but short", embedding=[0.1, 0.0]),
        ],
    )
    [best, _] = top_chunks(corpus, [1.0, 0.0], 2)
    assert best.chunk_index == 1


def test_a_figure_is_not_excused_as_arithmetic_by_pairing_a_figure_with_itself():
    """Any figure divided by itself is 1 and subtracted from itself is 0, so self-pairs would launder an invented "1 million" into "computed"."""
    scored = _support(
        "Revenue was $416,161 million; the segment contributed $1 million.",
        _chunks("Total net sales 416,161"),
    )
    assert scored["$1 million"] == "unsupported"


# --- local unit-scale lookup ---

def _corpus(*contents: str):
    from evals.eval_qa import CorpusChunk, FilingCorpus

    return FilingCorpus(
        accession_number="x", ticker="AAPL", chunk_size=2000, chunk_overlap=200,
        embed_model="gemini-embedding-001",
        chunks=[
            CorpusChunk(chunk_index=i, content=c, embedding=[1.0, 0.0])
            for i, c in enumerate(contents)
        ],
    )


def test_scale_for_takes_the_nearest_declaration_at_or_above_the_chunk():
    """An MD&A answer must get the MD&A header, not the income statement's: their exception lists differ."""
    from evals.eval_qa import scale_for

    corpus = _corpus(
        "(in thousands)",
        "some prose",
        "(in millions, except per share data)",
        "the chunk that was retrieved",
    )
    assert scale_for(corpus, 3) == "In millions, except per share data."


def test_scale_for_falls_back_to_the_first_declaration_above_the_chunk():
    from evals.eval_qa import scale_for

    corpus = _corpus("the chunk that was retrieved", "(in millions)")
    assert scale_for(corpus, 0) == "In millions."


def test_scale_for_returns_none_when_the_filing_never_declares_one():
    from evals.eval_qa import scale_for

    assert scale_for(_corpus("prose", "more prose"), 1) is None


def test_a_scale_word_in_passing_is_not_a_declaration():
    """units.extract_scale decides, not the prefilter: "one in millions of shoppers" mentions the phrase without declaring anything."""
    from evals.eval_qa import scale_for

    assert scale_for(_corpus("only one in millions of shoppers returns it"), 0) is None


def test_a_citation_marker_is_not_scored_as_a_figure():
    """The Q&A prompt asks for "(excerpt 2)" citations, so every answer carries numerals that claim nothing about the filing."""
    scored = _support(
        "Total net sales were $416,161 million (excerpt 1).",
        _chunks("Total net sales 416,161"),
    )
    assert scored == {"$416,161 million": "verbatim"}


def test_a_multi_source_citation_is_stripped_whole():
    scored = _support(
        "Revenue grew (excerpts 2 and 3).", _chunks("Total net sales 416,161")
    )
    assert scored == {}


# --- corpus completeness ---

def test_a_partial_corpus_is_refused_rather_than_scored_against(tmp_path, monkeypatch):
    """A build stopped by a refused reservation leaves a short file; running against it would understate retrieval for the chunks that are simply absent."""
    from evals import eval_qa
    from evals.eval_qa import CorpusChunk, FilingCorpus

    monkeypatch.setattr(eval_qa, "_CORPUS_DIR", tmp_path)
    partial = FilingCorpus(
        accession_number="a", ticker="AAPL", chunk_size=2000, chunk_overlap=200,
        embed_model="gemini-embedding-001", total_chunks=100,
        chunks=[CorpusChunk(chunk_index=0, content="c", embedding=[1.0])],
    )
    (tmp_path / "a.json").write_text(partial.model_dump_json())

    assert not partial.complete
    with pytest.raises(ValueError, match="1 of 100 chunks"):
        eval_qa.load_corpus("a")


def test_a_corpus_built_at_a_different_chunk_size_is_refused(tmp_path, monkeypatch):
    from evals import eval_qa
    from evals.eval_qa import CorpusChunk, FilingCorpus

    monkeypatch.setattr(eval_qa, "_CORPUS_DIR", tmp_path)
    stale = FilingCorpus(
        accession_number="a", ticker="AAPL", chunk_size=999, chunk_overlap=200,
        embed_model="gemini-embedding-001", total_chunks=1,
        chunks=[CorpusChunk(chunk_index=0, content="c", embedding=[1.0])],
    )
    (tmp_path / "a.json").write_text(stale.model_dump_json())

    with pytest.raises(ValueError, match="rebuild with --refresh"):
        eval_qa.load_corpus("a")


def test_batches_are_numbered_by_document_position_not_by_position_in_the_batch():
    """Indices are assigned a batch at a time, and scale_for reads the gaps between them as document distance."""
    from evals.eval_qa import numbered

    first = numbered(0, ["a", "b"], [[1.0], [2.0]])
    second = numbered(len(first), ["c", "d"], [[3.0], [4.0]])
    assert [c.chunk_index for c in first + second] == [0, 1, 2, 3]


def test_citation_precision_ignores_refusals(gate_env):
    """On an unanswerable question the model should draw on nothing, so its six unused excerpts must not count as citation misses."""
    scored = [score_record(_record()), score_record(_REFUSED)]
    result = totals(scored)
    assert result.sources_total == 2, "both questions still report their own sources"
    assert result.answerable_sources_total == 1
    assert result.citation_precision == 1.0
