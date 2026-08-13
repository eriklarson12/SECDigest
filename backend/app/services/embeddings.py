"""Chunking + embedding for filing Q&A (roadmap 5.1).

Retrieval is always scoped to a single filing, so the whole index for one
accession is a few hundred rows at most (MAX_CHUNKS) — small enough that exact
vector search beats an approximate index (no ivfflat; see the Supabase schema
in README).
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections import deque

from google.genai import types

from app.config import settings
from app.services import database
from app.services.llm import LLMError, LLMQuotaError, _get_client


logger = logging.getLogger(__name__)

# ~2000 chars ≈ 500 tokens: large enough to carry context, small enough that one
# chunk's embedding represents one topic rather than averaging several.
CHUNK_SIZE = 2000
# Overlap keeps a sentence that straddles a boundary findable from both sides.
CHUNK_OVERLAP = 200
CHUNK_STRIDE = CHUNK_SIZE - CHUNK_OVERLAP
# Cover everything fetch_filing_text decided to keep, so this cap never becomes
# the one doing the cutting. A flat 150 stopped at 270K chars — well under
# MAX_FILING_CHARS — which re-truncated in document order and threw away the
# tail of Risk Factors on long 10-Qs, exactly the sections _prioritize_sections
# had just been careful to select. Derived, so the two caps can't drift apart.
MAX_CHUNKS = math.ceil(settings.max_filing_chars / CHUNK_STRIDE)
# Truncated from the model's native 3072 dims (MRL). Cosine distance is
# magnitude-invariant, so the truncated vectors need no re-normalization.
EMBED_DIM = 768

# --- Free-tier rate limiting -------------------------------------------------
# gemini-embedding-001 on the free tier is capped at 30,000 input TOKENS PER
# MINUTE. Confirmed in AI Studio (Gemini API Rate Limit page), not inferred:
# during a full filing index the meter read TPM 18.08K/30K while RPM sat at
# 37/100 and RPD at 56/1,000. Requests are therefore effectively free and only
# tokens are rationed — send FEWER, FULLER requests, never more, smaller ones.
TOKENS_PER_MINUTE = 30_000
# Headroom under the cap for estimation error. A rejected request does not count
# toward the meter, so overshooting costs a wasted round trip rather than quota.
TOKEN_BUDGET = 27_000
RATE_WINDOW = 60.0
# Filing prose is token-dense (figures, punctuation, table whitespace): a 16-chunk
# batch of 2000-char chunks metered at 18.08K tokens, i.e. ~1.13K per chunk, or
# ~1.8 chars per token. Estimating low would under-pace, so this stays pessimistic.
CHARS_PER_TOKEN = 1.8
# Safety net for the occasional over-count; correct pacing should mean it rarely fires.
MAX_QUOTA_RETRIES = 2
MAX_RETRY_DELAY = 120.0

DOCUMENT_TASK = "RETRIEVAL_DOCUMENT"
QUERY_TASK = "RETRIEVAL_QUERY"

# Seams so tests can drive a fake clock instead of sleeping for real.
_now = time.monotonic
_sleep = asyncio.sleep

# Gemini reports its own backoff as `"retryDelay": "38s"` inside the 429 body.
_RETRY_DELAY_RE = re.compile(r"retryDelay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s")


def estimate_tokens(text: str) -> int:
    """Conservative token estimate — see CHARS_PER_TOKEN for the measurement."""
    return max(1, math.ceil(len(text) / CHARS_PER_TOKEN))


def plan_batches(texts: list[str], budget: int = TOKEN_BUDGET) -> list[list[str]]:
    """Greedily pack texts into the largest requests that fit the token budget.

    Requests are not the scarce resource — tokens are — so each batch is filled
    as full as it can go, and a single request never exceeds one minute's budget.
    """
    batches: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0

    for text in texts:
        tokens = estimate_tokens(text)
        if current and current_tokens + tokens > budget:
            batches.append(current)
            current, current_tokens = [], 0
        current.append(text)
        current_tokens += tokens

    if current:
        batches.append(current)
    return batches


def _retry_after_seconds(exc: BaseException) -> float | None:
    """The server's own retryDelay, if it told us one."""
    for candidate in (exc, exc.__cause__):
        if candidate is None:
            continue
        match = _RETRY_DELAY_RE.search(str(candidate))
        if match:
            return min(float(match.group(1)), MAX_RETRY_DELAY)
    return None


class TokenPacer:
    """Rolling-window token meter mirroring the server's TPM accounting.

    Only the out-of-band paths (the backfill script) pace: the inline analyze
    request must stay fast, so it sends one batch and accepts a partial index.
    """

    def __init__(self, budget: int = TOKEN_BUDGET, window: float = RATE_WINDOW):
        self._budget = budget
        self._window = window
        self._spent: deque[tuple[float, int]] = deque()

    def _used(self, now: float) -> int:
        while self._spent and now - self._spent[0][0] >= self._window:
            self._spent.popleft()
        return sum(tokens for _, tokens in self._spent)

    async def acquire(self, tokens: int) -> None:
        """Block until `tokens` fit inside the rolling window."""
        while True:
            now = _now()
            if not self._spent or self._used(now) + tokens <= self._budget:
                return
            # Wait for the oldest reservation to age out of the window.
            wait = self._window - (now - self._spent[0][0])
            logger.info("Token budget reached — waiting %.1fs for the window", wait)
            await _sleep(max(wait, 0) + 0.05)

    def record(self, tokens: int) -> None:
        """Count a *successful* request; rejected ones don't hit the server's meter."""
        self._spent.append((_now(), tokens))


def chunk_text(
    text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP
) -> list[str]:
    """Split filing text into overlapping chunks (pure — no I/O).

    Input is the already section-prioritized, capped text from
    edgar.fetch_filing_text; chunks come back in document order.
    """
    text = text.strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]

    stride = max(size - overlap, 1)
    chunks: list[str] = []
    for start in range(0, len(text), stride):
        piece = text[start : start + size].strip()
        if piece:
            chunks.append(piece)
        if len(chunks) >= MAX_CHUNKS:
            break
    return chunks


async def _embed_once(batch: list[str], task_type: str) -> list[list[float]]:
    """One embed_content call, with the analysis path's exact error mapping."""
    try:
        response = await _get_client().aio.models.embed_content(
            model=settings.gemini_embed_model,
            contents=batch,  # pyright: ignore[reportArgumentType]
            config=types.EmbedContentConfig(
                task_type=task_type,
                output_dimensionality=EMBED_DIM,
            ),
        )
    except (LLMQuotaError, LLMError):
        raise
    except Exception as e:
        code = getattr(e, "code", None) or getattr(e, "status_code", None)
        if code in (429, 503):
            logger.warning("Gemini embedding %s detail: %s", code, getattr(e, "message", str(e)))
            raise LLMQuotaError("Gemini embedding quota exhausted") from e
        raise LLMError("Gemini embedding request failed") from e

    vectors: list[list[float]] = []
    for embedding in response.embeddings or []:
        if embedding.values is None:
            raise LLMError("Gemini returned an embedding with no values")
        vectors.append(list(embedding.values))
    return vectors


async def _embed_batch(
    batch: list[str], task_type: str, pacer: TokenPacer | None
) -> list[list[float]]:
    """Embed one batch, pacing and retrying only when a pacer is supplied.

    Without a pacer a 429 propagates immediately: the inline analyze request
    must not stall waiting for the token window to refill.
    """
    tokens = sum(estimate_tokens(text) for text in batch)
    attempts = MAX_QUOTA_RETRIES + 1 if pacer else 1

    for attempt in range(attempts):
        if pacer:
            await pacer.acquire(tokens)
        try:
            vectors = await _embed_once(batch, task_type)
        except LLMQuotaError as e:
            if pacer is None or attempt == attempts - 1:
                raise
            delay = _retry_after_seconds(e) or RATE_WINDOW
            logger.warning(
                "Embedding 429 despite pacing — retrying in %.1fs (attempt %d/%d)",
                delay,
                attempt + 1,
                attempts - 1,
            )
            await _sleep(delay)
            continue

        if pacer:
            pacer.record(tokens)
        return vectors

    raise LLMQuotaError("Gemini embedding quota exhausted")  # pragma: no cover


async def embed_texts(
    texts: list[str], task_type: str, pacer: TokenPacer | None = None
) -> list[list[float]]:
    """Embed texts with Gemini, packed into the fewest requests that fit the cap.

    task_type matters: documents and the questions that they answer don't look
    alike, so DOCUMENT_TASK / QUERY_TASK map them into the same neighbourhood.
    Raises LLMQuotaError / LLMError exactly like the analysis path.
    """
    if not texts:
        return []

    vectors: list[list[float]] = []
    for batch in plan_batches(texts):
        vectors.extend(await _embed_batch(batch, task_type, pacer))

    if len(vectors) != len(texts):
        raise LLMError(
            f"Gemini returned {len(vectors)} embeddings for {len(texts)} inputs"
        )
    return vectors


async def index_filing(
    accession_number: str,
    filing_text: str,
    *,
    pacer: TokenPacer | None = None,
    resume: bool = False,
) -> int:
    """Chunk, embed and store one filing; returns the number of chunks stored.

    Two modes, because a full index costs minutes against the 30k tokens/minute cap:

    - Paced — what every caller uses. `services/indexing.py` (after an analysis)
      and `scripts/backfill_chunks.py` (repair) both wait for the token window
      between batches and index the filing to completion. `resume=True` skips
      chunks already stored, so a filing left partial by an interrupted run is
      topped up rather than re-embedded from scratch.
    - Unpaced — send exactly one batch and stop, never sleeping. No request path
      uses this since indexing moved off the analyze handler; it survives as the
      never-blocks primitive, and callers get a partial index covering the front
      of the filing. Don't reach for it without a reason to refuse to wait.
    """
    chunks = chunk_text(filing_text)
    if not chunks:
        return 0

    first_index = 0
    if resume:
        first_index = min(await database.chunk_count(accession_number), len(chunks))
        chunks = chunks[first_index:]
        if not chunks:
            logger.info("%s already fully indexed (%d chunks)", accession_number, first_index)
            return 0

    batches = plan_batches(chunks)
    if pacer is None:
        batches = batches[:1]  # inline: one request, never sleep

    stored = 0
    for batch in batches:
        try:
            vectors = await _embed_batch(batch, DOCUMENT_TASK, pacer)
        except LLMQuotaError:
            logger.warning(
                "Embedding quota hit for %s after %d/%d chunks — storing a partial index",
                accession_number,
                stored,
                len(chunks),
            )
            break
        await database.insert_chunks(
            accession_number,
            [
                (first_index + stored + offset, content, vector)
                for offset, (content, vector) in enumerate(zip(batch, vectors))
            ],
        )
        stored += len(batch)

    return stored
