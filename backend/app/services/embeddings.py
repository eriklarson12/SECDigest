"""Chunking + embedding for filing Q&A (roadmap 5.1).
Retrieval is scoped to one filing (a few hundred rows at most), so exact vector search beats an approximate index (no ivfflat)."""

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
# Cover everything fetch_filing_text kept, so this cap never re-truncates it. A flat 150 stopped at
# 270K chars and threw away Risk Factors' tail on long 10-Qs; deriving it keeps the two caps from drifting.
MAX_CHUNKS = math.ceil(settings.max_filing_chars / CHUNK_STRIDE)
# Truncated from the model's native 3072 dims (MRL). Cosine distance is
# magnitude-invariant, so the truncated vectors need no re-normalization.
EMBED_DIM = 768

# --- Free-tier rate limiting: two ceilings, metered differently — 30k input tokens/minute (TokenPacer
# paces this) vs. 1,000 requests/day counted per text not per HTTP call, so batching saves TPM but not daily quota; #2 resets on Google's clock, so hitting it raises rather than retries.
TOKENS_PER_MINUTE = 30_000
# Headroom under the cap for estimation error. A rejected request does not count
# toward the meter, so overshooting costs a wasted round trip rather than quota.
TOKEN_BUDGET = 27_000
RATE_WINDOW = 60.0
# Filing prose is token-dense: measured ~1.8 chars/token empirically (not the usual ~4).
# Estimating low would under-pace, so this stays pessimistic.
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
# A 429 names the ceiling it hit: metric names ending `_requests` are a request-count ceiling TokenPacer
# can't model (waiting is guesswork); only `_input_token_count` ceilings are ones a pause genuinely fixes.
_REQUEST_QUOTA_RE = re.compile(r"quota exceeded for metric:\s*\S*_requests\b", re.I)


class EmbeddingRequestQuotaError(LLMQuotaError):
    """The requests-per-day ceiling, as distinct from tokens-per-minute — needs the opposite response: don't retry, the day's budget is spent.
    Subclasses LLMQuotaError so existing handlers keep working; callers that can stop early catch this first."""


def estimate_tokens(text: str) -> int:
    """Conservative token estimate — see CHARS_PER_TOKEN for the measurement."""
    return max(1, math.ceil(len(text) / CHARS_PER_TOKEN))


def plan_batches(texts: list[str], budget: int = TOKEN_BUDGET) -> list[list[str]]:
    """Greedily pack texts into the largest requests that fit the token budget.
    Saves round trips and TPM headroom but *not* daily quota — that's metered per text, not per batch."""
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
    Only out-of-band paths (the backfill script) pace; the inline analyze request sends one batch and accepts a partial index."""

    def __init__(self, budget: int = TOKEN_BUDGET, window: float = RATE_WINDOW):
        self._budget = budget
        self._window = window
        self._spent: deque[tuple[float, int]] = deque()

    def _used(self, now: float) -> int:
        while self._spent and now - self._spent[0][0] >= self._window:
            self._spent.popleft()
        return sum(tokens for _, tokens in self._spent)

    async def acquire(self, tokens: int) -> None:
        """Block until `tokens` fit inside the rolling window.
        An empty window always admits — even oversized requests — so `_used` must purge before the emptiness check; reversing that order caused an IndexError on a drained window."""
        while True:
            now = _now()
            used = self._used(now)
            if not self._spent or used + tokens <= self._budget:
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
    Input is already the section-prioritized, capped text from edgar.fetch_filing_text; output stays in document order."""
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
            detail = getattr(e, "message", None) or str(e)
            logger.warning("Gemini embedding %s detail: %s", code, detail)
            if _REQUEST_QUOTA_RE.search(detail):
                raise EmbeddingRequestQuotaError(
                    "Gemini embedding request quota exhausted (resets daily)"
                ) from e
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
    Without a pacer a 429 propagates immediately — the inline analyze request must not stall waiting for the token window."""
    tokens = sum(estimate_tokens(text) for text in batch)
    attempts = MAX_QUOTA_RETRIES + 1 if pacer else 1

    for attempt in range(attempts):
        if pacer:
            await pacer.acquire(tokens)
        try:
            vectors = await _embed_once(batch, task_type)
        except EmbeddingRequestQuotaError:
            # No window to wait for — the daily counter resets on Google's clock.
            raise
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
    task_type matters: DOCUMENT_TASK / QUERY_TASK map documents and their questions into the same neighbourhood."""
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
    Paced (every real caller) waits for the token window to completion, with `resume=True` topping up a partial run; unpaced sends one batch and never sleeps."""
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
        except EmbeddingRequestQuotaError:
            # Propagate: every remaining filing would fail the same way, so the caller should stop
            # the run, not move on. Batches already inserted stay put for the next run to resume from.
            logger.warning(
                "Daily embedding request quota exhausted for %s after %d/%d chunks",
                accession_number,
                stored,
                len(chunks),
            )
            raise
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
