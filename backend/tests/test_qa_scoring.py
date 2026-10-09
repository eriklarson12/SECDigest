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
    monkeypatch.setattr(eval_qa, "_EXPERIMENTS_DIR", tmp_path / "qa_results" / "experiments")
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


# --- citation precision v2 (roadmap 13.1) ---

_FLOOR = 0.7


@pytest.mark.parametrize(
    "text, cited",
    [
        ("Sales fell (excerpt 1).", {1}),
        ("Spending rose (excerpt 2, 3).", {2, 3}),
        ("About thirty percent (excerpts 1, 3).", {1, 3}),
        ("It delivered 42,247 vehicles (excerpts [1], [2]).", {1, 2}),
        ("Not stated (excerpt 1, 2, 3, 4, 5, 6).", {1, 2, 3, 4, 5, 6}),
        ("See excerpts 2-4.", {2, 3, 4}),
        ("Revenue was $416,161 million.", set()),
    ],
)
def test_parse_citations_reads_every_marker_form_the_model_uses(text, cited):
    assert qa_scoring.parse_citations(text) == cited


def test_a_bracketed_citation_is_not_scored_as_figures():
    """The prompt numbers excerpts "[1]", and "(excerpts [1], [2])" once left "1" and "2" behind as figures that match every chunk."""
    scored = _support(
        "Rivian delivered 42,247 vehicles (excerpts [1], [2]).",
        _chunks("delivered 42,247 vehicles"),
    )
    assert scored == {"42,247": "verbatim"}


def test_split_sentences_keeps_decimals_and_abbreviations_whole():
    answer = (
        "Expenses rose $3.1 billion, e.g. for compute (excerpt 2). "
        "Margins fell (excerpt 1)."
    )
    assert qa_scoring.split_sentences(answer) == [
        "Expenses rose $3.1 billion, e.g. for compute .",
        "Margins fell .",
    ]


def test_split_sentences_treats_each_bullet_as_a_sentence():
    answer = "It comprises:\n- Server products (excerpt 2).\n- Enterprise services."
    assert qa_scoring.split_sentences(answer) == [
        "It comprises:",
        "Server products .",
        "Enterprise services.",
    ]


def test_a_marker_after_the_full_stop_belongs_to_the_sentence_before_it():
    units = qa_scoring.answer_units("About thirty percent. (excerpt 3)")
    assert units == [("About thirty percent.", {3})]


def _annotated(answer, chunks, sims, **kwargs):
    return QARecord(
        accession_number="x", ticker="TGT", question="Q?", answer=answer,
        chunks=chunks, sentence_similarity=sims, **kwargs,
    )


def test_a_small_integer_does_not_credit_every_chunk_that_prints_one():
    """v1 credited five of six TGT excerpts for "January 31"."""
    record = _annotated(
        "The fiscal year ends on the Saturday nearest January 31 (excerpt 1).",
        _chunks(
            "fiscal year ends on the Saturday nearest January 31",
            "31 stores", "store 31", "31 states",
        ),
        [],
    )
    score = score_record(record, floor=None)
    assert score.sources_used == 4, "v1 is kept as it was"
    assert score.sources_used_v2 == 1


def test_a_distinctive_figure_still_credits_its_chunk():
    record = _annotated(
        "Rivian produced 42,284 vehicles.",
        _chunks("produced 42,284 vehicles in 2025", "unrelated prose"),
        [],
    )
    assert score_record(record, floor=None).sources_used_v2 == 1


def test_a_sentence_credits_its_closest_chunk_only_above_the_floor():
    chunks = _chunks("alpha", "beta", "gamma")
    above = _annotated("A paraphrase.", chunks, [[0.5, 0.8, 0.6]])
    below = _annotated("A paraphrase.", chunks, [[0.5, 0.6, 0.65]])
    assert score_record(above, floor=_FLOOR).sources_used_v2 == 1
    assert score_record(below, floor=_FLOOR).sources_used_v2 == 0


def test_each_sentence_credits_at_most_one_chunk_it_did_not_cite():
    """Every retrieved chunk is on-topic, so all six may clear the floor; crediting them all would read 6/6 for any answer."""
    record = _annotated("A paraphrase.", _chunks(*"abcdef"), [[0.9, 0.85, 0.8, 0.8, 0.75, 0.72]])
    assert score_record(record, floor=_FLOOR).sources_used_v2 == 1


def test_a_cited_chunk_counts_only_when_it_supports_the_sentence():
    chunks = _chunks("alpha", "beta", "gamma")
    record = _annotated(
        "First claim (excerpt 2). Second claim (excerpt 3).",
        chunks,
        [[0.6, 0.9, 0.6], [0.95, 0.5, 0.4]],
    )
    score = score_record(record, floor=_FLOOR)
    assert score.markers == 2
    assert score.markers_verified == 1, "excerpt 3 sits at 0.4 for the sentence citing it"
    assert score.sources_used_v2 == 2, "chunk 2 cited and verified, chunk 1 closest to sentence two"


def test_a_marker_past_the_last_excerpt_is_counted_and_never_verified():
    record = _annotated("A claim (excerpt 9).", _chunks("alpha"), [[0.9]])
    score = score_record(record, floor=_FLOOR)
    assert (score.markers, score.markers_verified) == (1, 0)


def test_the_paraphrased_tgt_and_rivn_answers_no_longer_score_zero():
    """Both are grounded and cite an excerpt, and v1 scored both 0/6."""
    owned = _annotated(
        "Approximately thirty percent of Target's merchandise sales come from its "
        "owned and exclusive brands (excerpts 1, 3).",
        _chunks(*"abcdef"),
        [[0.81, 0.6, 0.78, 0.6, 0.55, 0.5]],
    )
    factory = _annotated(
        "Rivian manufactures its R1 platform vehicles at its manufacturing facility in "
        "Normal, Illinois, also known as the Normal Factory (excerpt 2).",
        _chunks(*"abcdef"),
        [[0.7, 0.84, 0.6, 0.6, 0.5, 0.5]],
    )
    assert score_record(owned, floor=_FLOOR).sources_used == 0
    assert score_record(owned, floor=_FLOOR).sources_used_v2 == 2
    assert score_record(factory, floor=_FLOOR).sources_used_v2 == 1


def test_a_record_without_similarities_falls_back_to_figures_and_8_grams():
    record = _annotated("A paraphrase (excerpt 1).", _chunks("alpha"), [])
    score = score_record(record, floor=_FLOOR)
    assert not score.has_similarities
    assert score.sources_used_v2 == 0
    assert totals([score]).unannotated == 1


def test_similarities_that_do_not_line_up_with_the_sentences_are_ignored():
    """A row count that disagrees with split_sentences means the splitter changed after `annotate`; reading the rows would credit the wrong sentence."""
    record = _annotated("One. Two.", _chunks("alpha"), [[0.99]])
    assert not score_record(record, floor=_FLOOR).has_similarities


def test_hit_at_3_reads_the_first_three_chunks():
    record = QARecord(
        accession_number="x", ticker="AAPL", question="Q?", answer="A.",
        expect_substring="needle",
        chunks=_chunks("a", "b", "has the needle", "d"),
    )
    score = score_record(record)
    assert (score.hit_at_1, score.hit_at_3, score.hit_at_k) == (False, True, True)


# --- annotate ---

def _vector_corpus(*contents: str):
    corpus = _corpus(*contents)
    for i, chunk in enumerate(corpus.chunks):
        chunk.embedding = [1.0, float(i)]
    return corpus


async def test_annotate_stores_one_row_per_sentence_and_one_column_per_chunk(monkeypatch):
    from evals import eval_qa

    async def fake_embed(texts, task, **_kwargs):
        assert task == "RETRIEVAL_QUERY"
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(eval_qa.embeddings, "embed_texts", fake_embed)
    corpus = _vector_corpus("alpha", "beta")
    record = QARecord(
        accession_number="x", ticker="AAPL", question="Q?",
        answer="One (excerpt 1). Two.",
        chunks=[RetrievedChunk(chunk_index=1, similarity=0.9, content="beta")],
    )
    await eval_qa.annotate_record(record, {"x": corpus})
    assert record.answer_sentences == ["One .", "Two."]
    assert len(record.sentence_similarity) == 2
    assert all(len(row) == 1 for row in record.sentence_similarity)


async def test_annotate_refuses_a_corpus_rebuilt_since_the_run(monkeypatch):
    from evals import eval_qa

    record = QARecord(
        accession_number="x", ticker="AAPL", question="Q?", answer="One.",
        chunks=[RetrievedChunk(chunk_index=0, similarity=0.9, content="old text")],
    )
    with pytest.raises(ValueError, match="no longer matches the corpus"):
        await eval_qa.annotate_record(record, {"x": _vector_corpus("new text")})


def test_the_null_distribution_excludes_a_questions_own_chunks():
    from evals.eval_qa import null_similarities

    corpus = _vector_corpus("a", "b", "c")
    own = QARecord(
        accession_number="x", ticker="AAPL", question="Q1", answer="A.",
        chunks=[RetrievedChunk(chunk_index=0, similarity=1, content="a")],
    )
    other = QARecord(
        accession_number="x", ticker="AAPL", question="Q2", answer="B.",
        chunks=[
            RetrievedChunk(chunk_index=0, similarity=1, content="a"),
            RetrievedChunk(chunk_index=2, similarity=1, content="c"),
        ],
    )
    found = null_similarities([own, other], {0: [[1.0, 0.0]]}, {"x": corpus})
    assert len(found) == 1, "chunk 0 is shared, so only chunk 2 is a null pair"


def test_percentile_is_nearest_rank():
    from evals.eval_qa import _percentile

    values = [i / 100 for i in range(1, 101)]
    assert _percentile(values, 99) == 0.99
    assert _percentile(values, 50) == 0.5


# --- retrieval experiments ---

@pytest.mark.parametrize(
    "order, ranked",
    [
        ([3, 1, 2], [2, 0, 1]),
        ([2], [1, 0, 2]),
        ([2, 2, 9, 0, 1], [1, 0, 2]),
        ([], [0, 1, 2]),
    ],
)
def test_a_sloppy_ranking_reorders_but_never_loses_an_excerpt(order, ranked):
    from app.services.llm import apply_ranking

    assert apply_ranking(order, 3) == ranked


async def test_rerank_keeps_the_top_k_of_the_reranked_pool(monkeypatch):
    from evals import eval_qa

    async def reverse(_question, excerpts):
        return list(reversed(range(len(excerpts))))

    monkeypatch.setattr(eval_qa, "rerank_chunks", reverse)
    corpus = _vector_corpus(*[f"c{i}" for i in range(20)])
    plain = await eval_qa._retrieve("Q?", corpus, [1.0, 0.0], 3, rerank=False)
    reranked = await eval_qa._retrieve("Q?", corpus, [1.0, 0.0], 3, rerank=True)
    pool = eval_qa.top_chunks(corpus, [1.0, 0.0], eval_qa._RERANK_POOL)
    assert [c.chunk_index for c in plain] == [c.chunk_index for c in pool[:3]]
    assert [c.chunk_index for c in reranked] == [c.chunk_index for c in pool[::-1][:3]]


def test_an_experiment_is_written_where_the_gate_cannot_see_it(gate_env):
    """An unshipped K=3 run named later than the baseline would otherwise become the run CI gates on."""
    _save_run(gate_env, "2026-09-14.json", [_record()])
    path = gate_env._artifact_path("2026-10-08", "k3", experiment=True)
    path.parent.mkdir(parents=True)
    path.write_text((gate_env._RESULTS_DIR / "2026-09-14.json").read_text())
    assert gate_env.latest_artifact_path().name == "2026-09-14.json"


def test_an_experimental_chunk_size_reads_its_own_corpus(tmp_path, monkeypatch):
    """A 1,500-char corpus must never be confused with the app's 2,000-char one, in either direction."""
    from evals import eval_qa
    from evals.eval_qa import CorpusChunk, FilingCorpus

    monkeypatch.setattr(eval_qa, "_CORPUS_DIR", tmp_path)
    small = FilingCorpus(
        accession_number="a", ticker="AAPL", chunk_size=1500, chunk_overlap=200,
        embed_model="gemini-embedding-001", total_chunks=1,
        chunks=[CorpusChunk(chunk_index=0, content="c", embedding=[1.0])],
    )
    path = eval_qa._corpus_path("a", 1500)
    assert path == tmp_path / "1500" / "a.json"
    path.parent.mkdir()
    path.write_text(small.model_dump_json())

    assert eval_qa.load_corpus("a", 1500).chunk_size == 1500
    with pytest.raises(FileNotFoundError):
        eval_qa.load_corpus("a")


# --- company scope (roadmap 13.2) ---

NEW_10K, OLD_10K = "new", "old"


def _company_record(chunks, answer="Sales fell (excerpt 1). They fell before too (excerpt 4).", **kw):
    return QARecord(
        accession_number=NEW_10K, ticker="AAPL", question="How did sales change?",
        scope="company", accession_numbers=[NEW_10K, OLD_10K],
        expect_substrings=["fell in 2025", "fell in 2024"], answer=answer, chunks=chunks, **kw,
    )


def _company_chunk(accession, index, content):
    return RetrievedChunk(chunk_index=index, similarity=0.8, content=content, accession_number=accession)


def test_a_company_hit_needs_every_filings_label():
    both = _company_record([
        _company_chunk(NEW_10K, 1, "Sales fell in 2025."), _company_chunk(NEW_10K, 2, "x"),
        _company_chunk(NEW_10K, 3, "y"), _company_chunk(OLD_10K, 4, "Sales fell in 2024."),
    ])
    one = _company_record([_company_chunk(NEW_10K, 1, "Sales fell in 2025."), _company_chunk(OLD_10K, 4, "z")])

    scored = qa_scoring.score_record(both)
    assert (scored.hit_at_1, scored.hit_at_3, scored.hit_at_k) == (None, False, True)
    assert qa_scoring.score_record(one).hit_at_k is False


def test_a_company_label_counts_only_in_its_own_filing():
    """Both 10-Ks repeat boilerplate; the old filing's label found in a new-filing chunk is not a hit."""
    record = _company_record([
        _company_chunk(NEW_10K, 1, "Sales fell in 2025. Sales fell in 2024."),
        _company_chunk(OLD_10K, 4, "unrelated"),
    ])
    assert qa_scoring.score_record(record).hit_at_k is False


def test_filings_cited_counts_distinct_filings_behind_the_markers():
    chunks = [
        _company_chunk(NEW_10K, 1, "a"), _company_chunk(NEW_10K, 2, "b"),
        _company_chunk(NEW_10K, 3, "c"), _company_chunk(OLD_10K, 4, "d"),
    ]
    assert qa_scoring.score_record(_company_record(chunks)).filings_cited == 2
    same = _company_record(chunks, answer="It fell (excerpts 1, 2). Out of range (excerpt 9).")
    assert qa_scoring.score_record(same).filings_cited == 1
    assert qa_scoring.score_record(_record(answer="Fine (excerpt 1).")).filings_cited is None


def test_totals_exclude_multi_label_rows_from_hit_at_1_and_report_multi_filing():
    chunks = [_company_chunk(NEW_10K, 1, "Sales fell in 2025."), _company_chunk(OLD_10K, 4, "Sales fell in 2024.")]
    company = qa_scoring.score_record(_company_record(chunks, answer="(excerpt 1) and (excerpt 2)."))
    single = qa_scoring.score_record(
        QARecord(accession_number="x", ticker="MSFT", question="Q?", expect_substring="alpha",
                 answer="Alpha.", chunks=[RetrievedChunk(chunk_index=0, similarity=0.9, content="alpha")])
    )
    result = qa_scoring.totals([company, single])

    assert result.hit_at_1_excluded == 1
    assert result.hit_rate_at_1 == 1.0
    assert result.hit_rate_at_k == 1.0
    assert (result.company_answerable, result.multi_filing_cited) == (1, 1)
    assert result.multi_filing_rate == 1.0


def test_the_report_tags_cross_filing_rows_and_states_the_multi_filing_line():
    chunks = [_company_chunk(NEW_10K, 1, "Sales fell in 2025."), _company_chunk(OLD_10K, 4, "Sales fell in 2024.")]
    record = _company_record(chunks, answer="(excerpt 1) and (excerpt 2).")
    artifact = QAArtifact(run_date="2026-10-09", model="m", retrieval_k=6, chunk_size=2000, records=[record])
    scores = [qa_scoring.score_record(record)]
    report = qa_scoring.render_markdown(artifact, scores, [qa_scoring.summarize(artifact, scores)])

    assert "(across filings) How did sales change?" in report
    assert "Cross-filing answers citing two or more filings: 1/1 (100.0%), reported, not gated" in report


@pytest.mark.parametrize(
    "fields, problem",
    [
        ({"accession_numbers": ["a"], "expect_substrings": ["x"]}, "two or more filings"),
        ({"accession_numbers": ["b", "c"], "expect_substrings": ["x", "y"]}, "not one of"),
        ({"accession_numbers": ["a", "b"], "expect_substrings": ["x"]}, "one label per filing"),
        ({"accession_numbers": ["a", "b"], "expect_substrings": ["x", "y"], "expect_substring": "x"}, "expect_substrings"),
    ],
)
def test_check_scope_rejects_malformed_company_questions(fields, problem):
    from evals.eval_qa import _check_scope

    question = qa_scoring.GoldenQuestion(
        accession_number="a", ticker="AAPL", question="Q?", scope="company", **fields
    )
    assert any(problem in p for p in _check_scope(question))


def test_check_scope_rejects_company_fields_on_a_filing_question():
    from evals.eval_qa import _check_scope

    question = qa_scoring.GoldenQuestion(
        accession_number="a", ticker="AAPL", question="Q?", accession_numbers=["a", "b"]
    )
    assert _check_scope(question)


def test_company_chunks_balances_filings_and_labels_each_chunk():
    """The eval's company retrieval MUST be the app's: best three per filing, then select_balanced."""
    from evals.eval_qa import company_chunks

    new = _vector_corpus(*[f"new {i}" for i in range(5)])
    new.accession_number, new.form_type, new.filing_date = NEW_10K, "10-K", "2025-10-31"
    old = _vector_corpus("old 0 (in millions)", "old 1")
    old.accession_number, old.form_type, old.filing_date = OLD_10K, "10-K", "2024-11-01"
    # [1, 0] is closest to chunk 0 of each corpus (embedding [1, i]).
    picked = company_chunks([new, old], [1.0, 0.0], 6)

    assert [(c.accession_number, c.chunk_index) for c in picked] == [
        (NEW_10K, 0), (OLD_10K, 0), (NEW_10K, 1), (OLD_10K, 1), (NEW_10K, 2)
    ]
    assert picked[1].filing_date == "2024-11-01" and picked[1].form_type == "10-K"
    assert picked[1].unit_scale == "In millions."
    assert picked[0].unit_scale is None


async def test_annotate_reads_each_chunk_from_its_own_filing(monkeypatch):
    from evals import eval_qa

    async def fake_embed(texts, task, **_kwargs):
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(eval_qa.embeddings, "embed_texts", fake_embed)
    new, old = _vector_corpus("same index, new"), _vector_corpus("same index, old")
    record = _company_record(
        [_company_chunk(NEW_10K, 0, "same index, new"), _company_chunk(OLD_10K, 0, "same index, old")],
        answer="One.",
    )
    await eval_qa.annotate_record(record, {NEW_10K: new, OLD_10K: old})
    assert len(record.sentence_similarity[0]) == 2


def test_question_filings_lists_every_filing_a_question_searches():
    from evals.eval_qa import question_filings

    company = qa_scoring.GoldenQuestion(
        accession_number="a", ticker="AAPL", question="Q?", scope="company", accession_numbers=["a", "b"]
    )
    filing = qa_scoring.GoldenQuestion(accession_number="a", ticker="AAPL", question="Q?")
    assert question_filings(company) == ["a", "b"]
    assert question_filings(filing) == ["a"]


def test_a_filing_date_from_the_prompt_label_is_grounded():
    """The company prompt labels each excerpt "10-K filed 2025-10-31", so "31" came from the model's input."""
    chunk = RetrievedChunk(
        chunk_index=1, similarity=0.9, content="Services gross margin percentage increased.",
        accession_number=NEW_10K, form_type="10-K", filing_date="2025-10-31",
    )
    record = _company_record([chunk], answer="The 10-K filed 2025-10-31 says it increased (excerpt 1).")
    assert qa_scoring.score_record(record).grounded
    assert qa_scoring.prompt_label(chunk) == "10-K filed 2025-10-31"


def test_a_date_no_label_shows_is_still_unsupported():
    chunk = RetrievedChunk(
        chunk_index=1, similarity=0.9, content="Services gross margin percentage increased.",
        accession_number=NEW_10K, form_type="10-K", filing_date="2025-10-31",
    )
    record = _company_record([chunk], answer="The 10-K filed 2025-10-29 says it increased (excerpt 1).")
    assert qa_scoring.score_record(record).unsupported == ["29"]


def test_a_filing_scope_chunk_has_no_label():
    assert qa_scoring.prompt_label(RetrievedChunk(chunk_index=0, similarity=1, content="x")) == ""
