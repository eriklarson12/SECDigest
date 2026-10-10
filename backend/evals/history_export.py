"""The eval run history as one committed JSON file, read by the frontend's static `/evals` page.
Each `score` command owns one suite's key and keeps the other's. Output is deterministic, so a re-score with nothing new leaves no diff and CI can gate on staleness."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

Suite = Literal["extraction", "qa"]

HISTORY_PATH = Path(__file__).parent.parent.parent / "frontend" / "src" / "data" / "eval-history.json"


def _runs(runs: Sequence[BaseModel]) -> list[dict[str, Any]]:
    return [run.model_dump() for run in sorted(runs, key=lambda r: getattr(r, "run_date"))]


def _load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def render(existing: dict[str, Any], suite: Suite, runs: Sequence[BaseModel]) -> str:
    return json.dumps({**existing, suite: _runs(runs)}, indent=2, sort_keys=True) + "\n"


def write(suite: Suite, runs: Sequence[BaseModel], path: Path = HISTORY_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(_load(path), suite, runs))


def is_current(suite: Suite, runs: Sequence[BaseModel], path: Path = HISTORY_PATH) -> bool:
    return _load(path).get(suite) == _runs(runs)
