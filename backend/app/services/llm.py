from __future__ import annotations

import logging

from google import genai
from google.genai import types
from pydantic import ValidationError

from app.config import settings
from app.models.schemas import FilingAnalysis


logger = logging.getLogger(__name__)


class LLMError(Exception):
    """LLM request failed or returned unusable output."""


class LLMQuotaError(LLMError):
    """Free-tier quota / rate limit exhausted (maps to HTTP 503)."""


_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


_SYSTEM_PROMPT = """You are an expert financial analyst. You will be given the full text of a U.S. SEC filing — either a Form 10-K (annual report) or Form 10-Q (quarterly report). Extract the requested fields and return ONLY JSON conforming to the provided schema.

Rules:
- revenue.current: total revenue for the most recent reporting period covered by this filing — the full fiscal year for a 10-K, the most recent fiscal quarter for a 10-Q. Read it from the consolidated statements of operations. Treat "net sales", "total net revenues", or "total revenues" as revenue.
- revenue.yoy_change_pct: percentage change versus the same period one year earlier (prior fiscal year for a 10-K; same quarter of the prior year for a 10-Q), computed as (current - prior) / |prior| * 100, rounded to 1 decimal place. If the prior-period figure does not appear in the filing, use null.
- net_income.current and net_income.yoy_change_pct: same rules, using bottom-line net income (loss) attributable to the company. A net loss is a negative number.
- All monetary values are absolute USD. Apply the filing's stated scale: if statements are "in thousands" multiply by 1e3, "in millions" by 1e6 (e.g., report $394.328 billion as 394328000000).
- risk_factors: the 5 most material risk factors, at most one plain-English sentence each, in your own words (fewer than 5 only if the filing lists fewer). If a 10-Q states there are "no material changes" from the prior 10-K's risk factors, summarize the most significant risks it references, or return ["Company reported no material changes to previously disclosed risk factors."].
- management_guidance: 1-3 sentences summarizing management's forward-looking outlook, drawn from MD&A or an outlook/guidance section. If the filing contains no forward-looking guidance, return exactly: "No explicit guidance provided in this filing."
- summary: 2-3 sentences in plain English a retail investor could understand: what happened this period and why it matters.
- Never invent or estimate numbers that are not in the filing text. Use null for any numeric value you cannot find. If the text appears truncated, extract what is present."""


_QA_SYSTEM_PROMPT = """You are a financial analyst answering a question about a single SEC filing. You will be given numbered excerpts retrieved from that filing.

Rules:
- Answer ONLY from the excerpts provided. Never use outside knowledge about the company, and never estimate or infer figures that are not in the excerpts.
- If the excerpts do not contain the answer, say so plainly in one sentence — do not guess. The excerpts are drawn from the filing's narrative sections (cover page, Risk Factors, MD&A), not its financial statement tables, so when a question asks for a figure that isn't there, say the narrative sections don't state it.
- Cite the excerpts you used by their number, e.g. "(excerpt 2)".
- Be concise: at most 4 sentences, in plain English a retail investor could understand.
- Quote exact figures as they appear in the excerpts. When a "Unit scale" line is given, the excerpts' figures are stated in that scale — restate them with it, e.g. "$11,133 million". Honour its exceptions exactly: anything the line excludes (per-share amounts, share counts, percentages, store counts) is NOT in that scale and must be quoted as printed. When no such line is given, do not guess a scale."""


async def analyze_filing(
    filing_text: str,
    form_type: str,
    company_name: str,
    ticker: str,
) -> FilingAnalysis:
    """Send filing text to Gemini and get structured analysis back.

    Retries once on malformed/schema-mismatched output; raises LLMQuotaError on
    429 so the router can answer 503, LLMError on anything else.
    """
    text = filing_text[: settings.max_filing_chars]
    user_prompt = f"Analyze this {form_type} filing for {company_name} ({ticker}):\n\n{text}"
    config = types.GenerateContentConfig(
        system_instruction=_SYSTEM_PROMPT,
        response_mime_type="application/json",
        response_schema=FilingAnalysis,
        temperature=0.1,
    )

    last_error: Exception | None = None
    for attempt in range(2):
        response = await _generate_with_quota_fallback(user_prompt, config)

        try:
            return FilingAnalysis.model_validate_json(response.text or "")
        except (ValidationError, ValueError) as e:
            logger.warning("Malformed LLM output on attempt %d: %s", attempt + 1, e)
            last_error = e

    raise LLMError("LLM returned malformed output after retry") from last_error


async def answer_question(
    question: str, excerpts: list[str], unit_scale: str | None = None
) -> str:
    """Answer a question strictly from retrieved filing excerpts (roadmap 5.1).

    Plain text, not structured output — the caller supplies the citations from
    the retrieval step. Quota errors surface as LLMQuotaError exactly as in
    analyze_filing, but on its own model pair (GEMINI_QA_MODEL — see _qa_models).

    `unit_scale` is the filing's own scale declaration for these excerpts (see
    services/units.py). It's passed separately rather than left to the excerpts
    because filings state it once in a section header that retrieval rarely
    returns, which is how "$11,133 million" ends up quoted as "$11,133".
    """
    numbered = "\n\n".join(f"[{i + 1}] {text}" for i, text in enumerate(excerpts))
    scale_line = f"Unit scale: {unit_scale}\n\n" if unit_scale else ""
    user_prompt = (
        f"Question: {question}\n\n{scale_line}Excerpts from the filing:\n\n{numbered}"
    )
    config = types.GenerateContentConfig(
        system_instruction=_QA_SYSTEM_PROMPT,
        temperature=0.1,
    )

    primary, fallback = _qa_models()
    response = await _generate_with_quota_fallback(user_prompt, config, primary, fallback)
    answer = (response.text or "").strip()
    if not answer:
        raise LLMError("Gemini returned an empty answer")
    return answer


async def _generate(model: str, user_prompt: str, config: types.GenerateContentConfig):
    try:
        return await _get_client().aio.models.generate_content(
            model=model,
            contents=user_prompt,
            config=config,
        )
    except Exception as e:
        code = getattr(e, "code", None) or getattr(e, "status_code", None)
        if code == 429:
            logger.warning("Gemini 429 detail: %s", getattr(e, "message", str(e)))
            raise LLMQuotaError("Gemini quota exhausted") from e
        if code == 503:
            logger.warning("Gemini 503 detail: %s", getattr(e, "message", str(e)))
            raise LLMQuotaError("Gemini overloaded") from e
        raise LLMError("Gemini request failed") from e


def _qa_models() -> tuple[str, str]:
    """Primary + fallback model for the Q&A path.

    Gemini meters requests per day *per model*, so pointing Q&A at its own model
    gives questions a separate daily pool from analyses — a day of heavy asking
    no longer eats the budget analyses need, and the interactive path skips the
    wasted 429 round trip it would otherwise pay once the analysis model is out.

    It falls back *up* to the analysis model rather than to GEMINI_FALLBACK_MODEL,
    which by default is the same lite model Q&A already runs on — a fallback is
    only worth making if it lands in a different pool.
    """
    primary = settings.gemini_qa_model or settings.gemini_model
    fallback = settings.gemini_model
    if fallback == primary:
        # Q&A shares the analysis model — fall back the way analyses do.
        fallback = settings.gemini_fallback_model
    return primary, fallback


async def _generate_with_quota_fallback(
    user_prompt: str,
    config: types.GenerateContentConfig,
    primary: str | None = None,
    fallback: str | None = None,
):
    """Quota exhaustion on the primary model retries once on the fallback model.

    Only quota errors switch models — malformed-output retries stay on the
    same model (the analyze_filing loop). No extra daily-cap unit is consumed:
    quota.try_consume was already spent for this analysis.

    Defaults are the analysis pair; the Q&A path passes its own (see _qa_models).
    """
    primary = primary or settings.gemini_model
    # `is None`, not `or`: "" is a caller explicitly disabling the fallback.
    fallback = settings.gemini_fallback_model if fallback is None else fallback
    try:
        return await _generate(primary, user_prompt, config)
    except LLMQuotaError:
        if not fallback or fallback == primary:
            raise
        logger.warning("gemini quota on %s — falling back to %s", primary, fallback)
        return await _generate(fallback, user_prompt, config)
