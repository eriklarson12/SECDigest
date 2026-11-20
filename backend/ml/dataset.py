"""Annual XBRL frames for the net-loss base rate (roadmap 17.1).

Every request goes through edgar's paced client, so a cold build holds the same 8/s the dyno does.
Each frame is cached trimmed to `cik -> value` under `ml/.cache/`; the parsed body is 3 MB of
objects for NetIncomeLoss CY2025, the trimmed one a few hundred KB.

Run from backend/:  python -m ml.dataset count net_income
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import httpx

from app.services import edgar
from app.services.frames import _FRAMES_URL, _MIN_FRAME_POINTS
from app.services.xbrl import _OCF_CONCEPTS, _REVENUE_CONCEPTS

CACHE_DIR = Path(__file__).parent / ".cache"

FIRST_YEAR = 2010
LAST_YEAR = 2025

# Duration concepts only: an instant frame does not line up with a fiscal year (roadmap 9.4).
# Each metric's candidates are a union, first candidate winning per filer, never summed.
METRICS: dict[str, list[str]] = {
    "revenue": _REVENUE_CONCEPTS,
    "net_income": ["NetIncomeLoss"],
    "gross_profit": ["GrossProfit"],
    "operating_income": ["OperatingIncomeLoss"],
    "operating_cash_flow": _OCF_CONCEPTS,
}


def _cache_path(concept: str, year: int) -> Path:
    return CACHE_DIR / f"{concept}-CY{year}.json"


def _trim(body: dict) -> dict[int, float]:
    out: dict[int, float] = {}
    for point in body.get("data", []):
        cik, val = point.get("cik"), point.get("val")
        if cik is not None and val is not None:
            out[int(cik)] = float(val)
    return out


async def fetch_frame(concept: str, year: int) -> dict[int, float]:
    """One concept's annual frame, `{}` when SEC has none (a 404 is an absence, not a failure)."""
    path = _cache_path(concept, year)
    if path.exists():
        return {int(k): v for k, v in json.loads(path.read_text()).items()}

    url = _FRAMES_URL.format(concept=concept, period=f"CY{year}")
    try:
        resp = await edgar._get_with_retry(url, timeout=60)
        frame = _trim(resp.json())
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != 404:
            raise
        frame = {}

    CACHE_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(frame, separators=(",", ":"), sort_keys=True))
    return frame


async def fetch_metric(metric: str, year: int) -> dict[int, float]:
    merged: dict[int, float] = {}
    for concept in METRICS[metric]:
        for cik, value in (await fetch_frame(concept, year)).items():
            merged.setdefault(cik, value)
    return merged


async def _count(metric: str) -> None:
    try:
        print(f"{metric}\n{'year':<6}{'filers':>8}")
        for year in range(FIRST_YEAR, LAST_YEAR + 1):
            n = len(await fetch_metric(metric, year))
            flag = "" if n >= _MIN_FRAME_POINTS else f"  under {_MIN_FRAME_POINTS:,}"
            print(f"CY{year:<4}{n:>8,}{flag}")
    finally:
        await edgar.close_client()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m ml.dataset")
    sub = parser.add_subparsers(dest="command", required=True)
    count = sub.add_parser("count", help="filer count per annual frame")
    count.add_argument("metric", choices=sorted(METRICS))
    args = parser.parse_args()
    if args.command == "count":
        asyncio.run(_count(args.metric))


if __name__ == "__main__":
    main()
