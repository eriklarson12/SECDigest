"""Measure language drift between consecutive same-form filings (roadmap 12.1, step 0).
Reads the live database, writes nothing, never CI.

Spends no quota: no Gemini, no EDGAR. Embeddings come back over the wire as JSON strings,
which the endpoint must never do (see upsert_filing_vector in schema.sql). That is acceptable
here only because this runs by hand, a handful of times. Cosine is computed in plain Python:
the $0 rule keeps numpy out of requirements, and a pair takes seconds.

Prints, per pair: centroid cosine, the distribution of each new chunk's best match in the old
filing, the share of chunks at or above candidate thresholds, and the lowest-scoring excerpts
for a human to judge. A cross-company control pair shows where unrelated text sits."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import operator
import sys
from dataclasses import dataclass
from typing import cast

from app.models.schemas import AnalysisResponse
from app.services import database

logger = logging.getLogger("measure-drift")

_PAGE_SIZE = 100
_CHUNK_PAGE = 500
_THRESHOLDS = (0.85, 0.90, 0.93, 0.95, 0.97, 0.99)


@dataclass
class Chunk:
    index: int
    content: str
    unit: list[float]


async def _load_analyses() -> list[AnalysisResponse]:
    rows: list[AnalysisResponse] = []
    offset = 0
    while True:
        page, total = await database.list_analyses(limit=_PAGE_SIZE, offset=offset)
        if not page:
            break
        rows.extend(page)
        offset += len(page)
        if offset >= total:
            break
    return rows


def _unit(raw: str) -> list[float]:
    vec = cast(list[float], json.loads(raw))
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec]


def _dot(a: list[float], b: list[float]) -> float:
    return sum(map(operator.mul, a, b))


def _chunks_sync(accession: str) -> list[Chunk]:
    out: list[Chunk] = []
    start = 0
    while True:
        result = (
            database._get_client()
            .table("filing_chunks")
            .select("chunk_index, content, embedding")
            .eq("accession_number", accession)
            .not_.is_("embedding", "null")
            .order("chunk_index")
            .range(start, start + _CHUNK_PAGE - 1)
            .execute()
        )
        rows = cast(list[dict], result.data or [])
        out.extend(
            Chunk(row["chunk_index"], row["content"], _unit(row["embedding"]))
            for row in rows
        )
        if len(rows) < _CHUNK_PAGE:
            return out
        start += _CHUNK_PAGE


def _centroid_sync(accession: str) -> list[float] | None:
    result = (
        database._get_client()
        .table("filing_vectors")
        .select("centroid")
        .eq("accession_number", accession)
        .limit(1)
        .execute()
    )
    rows = cast(list[dict], result.data or [])
    return _unit(rows[0]["centroid"]) if rows else None


def _digit_ratio(text: str) -> float:
    """Digits over non-space characters: high for tables and cover pages, low for prose."""
    chars = [c for c in text if not c.isspace()]
    return sum(c.isdigit() for c in chars) / len(chars) if chars else 0.0


def _percentile(sorted_values: list[float], p: float) -> float:
    k = (len(sorted_values) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


async def _indexed(row: AnalysisResponse) -> bool:
    """A partial index would read as drift: the missing chunks have no match to find."""
    count = await database.chunk_count(row.accession_number)
    return count > 0 and (row.chunks_expected is None or count >= row.chunks_expected)


async def _pick_pairs(
    rows: list[AnalysisResponse], want: int, prefer: list[str]
) -> list[tuple[AnalysisResponse, AnalysisResponse]]:
    """One pair per ticker: the newest filing and its prior under 12.1's rule (same cik, same
    form, latest earlier filing_date)."""
    groups: dict[tuple[str, str], list[AnalysisResponse]] = {}
    for row in rows:
        if row.filing_date:
            groups.setdefault((row.cik, row.form_type), []).append(row)

    candidates = [g for g in groups.values() if len(g) >= 2]
    candidates.sort(
        key=lambda g: (g[0].ticker not in prefer, g[0].form_type != "10-K", g[0].ticker)
    )

    pairs: list[tuple[AnalysisResponse, AnalysisResponse]] = []
    seen: set[str] = set()
    for group in candidates:
        if len(pairs) >= want:
            break
        ticker = group[0].ticker
        if ticker in seen:
            continue
        group.sort(key=lambda r: r.filing_date or "", reverse=True)
        new, old = group[0], group[1]
        if not (await _indexed(new) and await _indexed(old)):
            logger.info("%s %s skipped: a filing is not fully indexed", ticker, new.form_type)
            continue
        pairs.append((new, old))
        seen.add(ticker)
    return pairs


def _label(row: AnalysisResponse) -> str:
    return f"{row.ticker} {row.form_type} {row.filing_date}"


async def _measure(new: AnalysisResponse, old: AnalysisResponse, excerpts: int) -> None:
    new_chunks, old_chunks, c_new, c_old = await asyncio.gather(
        asyncio.to_thread(_chunks_sync, new.accession_number),
        asyncio.to_thread(_chunks_sync, old.accession_number),
        asyncio.to_thread(_centroid_sync, new.accession_number),
        asyncio.to_thread(_centroid_sync, old.accession_number),
    )

    maxima = [
        (max(_dot(n.unit, o.unit) for o in old_chunks), n) for n in new_chunks
    ]
    values = sorted(m for m, _ in maxima)

    print(f"\n### {_label(new)}  vs  {_label(old)}")
    print(f"chunks: {len(new_chunks)} new, {len(old_chunks)} old")
    centroid = f"{_dot(c_new, c_old):.4f}" if c_new and c_old else "n/a (no centroid)"
    print(f"centroid cosine: {centroid}")
    print(
        "per-chunk max: "
        f"min {values[0]:.3f} · p10 {_percentile(values, 0.10):.3f} · "
        f"p50 {_percentile(values, 0.50):.3f} · p90 {_percentile(values, 0.90):.3f} · "
        f"mean {sum(values) / len(values):.3f}"
    )
    shares = " · ".join(
        f">={t:.2f}: {sum(v >= t for v in values) / len(values):.0%}" for t in _THRESHOLDS
    )
    print(f"carried over at: {shares}")

    if excerpts:
        print("lowest-scoring new passages:")
        for score, chunk in sorted(maxima, key=lambda m: m[0])[:excerpts]:
            text = " ".join(chunk.content.split())[:240]
            ratio = _digit_ratio(chunk.content)
            print(f"  [{score:.3f} · digits {ratio:.2f}] chunk {chunk.index}: {text}")


async def run(want: int, prefer: list[str], excerpts: int) -> int:
    rows = await _load_analyses()
    pairs = await _pick_pairs(rows, want, prefer)
    if not pairs:
        logger.error("No ticker has two fully indexed same-form filings.")
        return 1
    if len(pairs) < want:
        logger.warning("Only %d pair(s) qualify, wanted %d.", len(pairs), want)

    print("## Same-company pairs")
    for new, old in pairs:
        await _measure(new, old, excerpts)

    print("\n## Control: different companies, same form")
    if len(pairs) >= 2:
        await _measure(pairs[0][0], pairs[1][0], excerpts=0)
    else:
        print("n/a: needs two qualifying tickers")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pairs", type=int, default=5, help="Same-company pairs to measure")
    parser.add_argument(
        "--prefer",
        default="AAPL",
        help="Comma-separated tickers to pick first (default: AAPL, the acceptance case)",
    )
    parser.add_argument(
        "--excerpts", type=int, default=3, help="Lowest-scoring passages to print per pair"
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    prefer = [t.strip().upper() for t in args.prefer.split(",") if t.strip()]
    return asyncio.run(run(args.pairs, prefer, args.excerpts))


if __name__ == "__main__":
    sys.exit(main())
