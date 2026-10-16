import re
from pathlib import Path

from app.models.schemas import TICKER_RE

TICKER_TS = Path(__file__).parents[2] / "frontend" / "src" / "lib" / "ticker.ts"


def test_ticker_pattern_matches_the_frontend():
    """frontend/src/lib/ticker.ts mirrors TICKER_RE."""
    match = re.search(r"export const TICKER_RE = /(.+)/;", TICKER_TS.read_text())
    assert match is not None
    assert match.group(1) == TICKER_RE.pattern
