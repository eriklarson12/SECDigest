"""Write the FastAPI OpenAPI schema to a file (roadmap 11.3).

Runs with a completely empty environment: no secrets, no network, no Supabase. Every
`Settings` field has a default, which is what makes that true and what keeps CI's
`contract` job secret-free. A required setting added to `config.py` breaks this, and the
fix is a dummy value in the workflow, not a real secret.

Keys are sorted so a schema change produces a reviewable diff rather than a reshuffle.
"""

from __future__ import annotations

import json
import sys

from app.main import app


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python scripts/dump_openapi.py <output.json>", file=sys.stderr)
        return 2

    with open(argv[1], "w", encoding="utf-8") as handle:
        json.dump(app.openapi(), handle, indent=2, sort_keys=True)
        handle.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
