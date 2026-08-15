import pytest

from app.config import settings
from app.services import llm
from app.services.llm import LLMError, LLMQuotaError, analyze_filing, answer_question


class FakeResponse:
    def __init__(self, text):
        self.text = text


class FakeGenAI:
    """Stands in for genai.Client; returns queued texts or raises queued errors."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []
        self.aio = self
        self.models = self

    async def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeResponse(outcome)


@pytest.fixture
def fake_client(monkeypatch):
    def _install(outcomes):
        fake = FakeGenAI(outcomes)
        monkeypatch.setattr(llm, "_get_client", lambda: fake)
        return fake

    return _install


async def test_valid_json_parses(fake_client, valid_analysis_json):
    fake_client([valid_analysis_json])
    result = await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert result.revenue.current == 1000000000
    assert result.revenue.yoy_change_pct == 5.5
    assert result.net_income.yoy_change_pct is None  # nulls preserved
    assert result.risk_factors == ["Supply chain concentration risk."]


async def test_malformed_then_valid_retries_once(
    fake_client, malformed_analysis_json, valid_analysis_json
):
    fake = fake_client([malformed_analysis_json, valid_analysis_json])
    result = await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert len(fake.calls) == 2
    assert result.summary == "Revenue grew 5.5% year over year."


async def test_malformed_twice_raises_llm_error(fake_client, malformed_analysis_json):
    fake = fake_client([malformed_analysis_json, malformed_analysis_json])
    with pytest.raises(LLMError):
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert len(fake.calls) == 2


async def test_input_truncated_to_cap(monkeypatch, fake_client, valid_analysis_json):
    monkeypatch.setattr(settings, "max_filing_chars", 100)
    fake = fake_client([valid_analysis_json])
    long_text = "x" * 200 + "END_MARKER"
    await analyze_filing(long_text, "10-K", "Apple Inc.", "AAPL")
    contents = fake.calls[0]["contents"]
    assert "END_MARKER" not in contents
    assert contents.endswith("x" * 100)


class FakeQuotaError(Exception):
    code = 429


async def test_quota_error_maps_to_llm_quota_error(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_fallback_model", "")  # isolate the mapping
    quota_exc = FakeQuotaError("resource exhausted")
    fake_client([quota_exc])
    with pytest.raises(LLMQuotaError):
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")


class FakeOverloadError(Exception):
    code = 503


async def test_overload_maps_to_a_distinguishable_quota_error(monkeypatch, fake_client):
    """A 503 stays a LLMQuotaError — the router's 503 + Retry-After is unchanged —
    but batch callers (evals/) need to tell a busy model from a spent daily pool,
    because only one of the two is worth waiting out."""
    monkeypatch.setattr(settings, "gemini_fallback_model", "")
    fake_client([FakeOverloadError("high demand")])
    with pytest.raises(llm.LLMOverloadedError):
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")


async def test_a_spent_daily_pool_is_not_reported_as_an_overload(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_fallback_model", "")
    fake_client([FakeQuotaError("resource exhausted")])
    with pytest.raises(LLMQuotaError) as excinfo:
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert not isinstance(excinfo.value, llm.LLMOverloadedError)


async def test_other_api_error_maps_to_llm_error(fake_client):
    fake_client([RuntimeError("network down")])
    with pytest.raises(LLMError):
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")


async def test_model_comes_from_settings(monkeypatch, fake_client, valid_analysis_json):
    monkeypatch.setattr(settings, "gemini_model", "gemini-2.5-flash-lite")
    fake = fake_client([valid_analysis_json])
    await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert fake.calls[0]["model"] == "gemini-2.5-flash-lite"


# --- quota fallback model (roadmap 2.5) ---

async def test_quota_on_primary_falls_back_and_succeeds(
    fake_client, valid_analysis_json
):
    fake = fake_client([FakeQuotaError("exhausted"), valid_analysis_json])
    result = await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert result.revenue.current == 1000000000
    assert [c["model"] for c in fake.calls] == [
        settings.gemini_model,
        settings.gemini_fallback_model,
    ]


async def test_quota_on_both_models_raises_quota_error(fake_client):
    fake = fake_client([FakeQuotaError("a"), FakeQuotaError("b")])
    with pytest.raises(LLMQuotaError):
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert len(fake.calls) == 2


async def test_fallback_disabled_raises_immediately(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_fallback_model", "")
    fake = fake_client([FakeQuotaError("exhausted")])
    with pytest.raises(LLMQuotaError):
        await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert len(fake.calls) == 1


async def test_malformed_output_does_not_switch_models(
    fake_client, malformed_analysis_json, valid_analysis_json
):
    fake = fake_client([malformed_analysis_json, valid_analysis_json])
    await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")
    assert [c["model"] for c in fake.calls] == [settings.gemini_model] * 2


# --- Q&A model routing (GEMINI_QA_MODEL) ---
# RPD is metered per model, so Q&A runs on its own model to keep questions from
# spending the analysis budget. Fallback goes *up* to the analysis model: the
# default GEMINI_FALLBACK_MODEL is the same lite model Q&A already runs on, and
# a fallback into the pool that just 429'd buys nothing.

EXCERPTS = ["Net cash provided by operating activities totaled $11,133."]


async def test_qa_uses_its_own_model_not_the_analysis_one(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_model", "flash")
    monkeypatch.setattr(settings, "gemini_qa_model", "lite")
    fake = fake_client(["Operating cash flow was $11,133 million (excerpt 1)."])

    await answer_question("How much cash from operations?", EXCERPTS)

    assert [c["model"] for c in fake.calls] == ["lite"]


async def test_qa_quota_falls_back_to_the_analysis_model(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_model", "flash")
    monkeypatch.setattr(settings, "gemini_qa_model", "lite")
    fake = fake_client([FakeQuotaError("exhausted"), "Answered (excerpt 1)."])

    answer = await answer_question("How much cash from operations?", EXCERPTS)

    assert answer == "Answered (excerpt 1)."
    assert [c["model"] for c in fake.calls] == ["lite", "flash"]


async def test_qa_without_its_own_model_behaves_like_analysis(monkeypatch, fake_client):
    """An empty GEMINI_QA_MODEL restores the pre-split single-pool behaviour."""
    monkeypatch.setattr(settings, "gemini_model", "flash")
    monkeypatch.setattr(settings, "gemini_qa_model", "")
    monkeypatch.setattr(settings, "gemini_fallback_model", "lite")
    fake = fake_client([FakeQuotaError("exhausted"), "Answered (excerpt 1)."])

    await answer_question("How much cash from operations?", EXCERPTS)

    assert [c["model"] for c in fake.calls] == ["flash", "lite"]


async def test_qa_pinned_to_the_analysis_model_still_falls_back(monkeypatch, fake_client):
    """Same model set both places must not collapse into "no fallback"."""
    monkeypatch.setattr(settings, "gemini_model", "flash")
    monkeypatch.setattr(settings, "gemini_qa_model", "flash")
    monkeypatch.setattr(settings, "gemini_fallback_model", "lite")
    fake = fake_client([FakeQuotaError("exhausted"), "Answered (excerpt 1)."])

    await answer_question("How much cash from operations?", EXCERPTS)

    assert [c["model"] for c in fake.calls] == ["flash", "lite"]


async def test_qa_quota_on_both_models_raises(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_qa_model", "lite")
    fake = fake_client([FakeQuotaError("a"), FakeQuotaError("b")])

    with pytest.raises(LLMQuotaError):
        await answer_question("How much cash from operations?", EXCERPTS)
    assert len(fake.calls) == 2


async def test_analysis_model_is_unaffected_by_the_qa_setting(
    monkeypatch, fake_client, valid_analysis_json
):
    monkeypatch.setattr(settings, "gemini_model", "flash")
    monkeypatch.setattr(settings, "gemini_qa_model", "lite")
    fake = fake_client([valid_analysis_json])

    await analyze_filing("filing text", "10-Q", "Apple Inc.", "AAPL")

    assert fake.calls[0]["model"] == "flash"


async def test_qa_empty_answer_raises(monkeypatch, fake_client):
    monkeypatch.setattr(settings, "gemini_qa_model", "lite")
    fake_client(["   "])
    with pytest.raises(LLMError):
        await answer_question("How much cash from operations?", EXCERPTS)
