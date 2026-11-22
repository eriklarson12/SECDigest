"""Score the latest calendar year and store one net-loss base rate per company (roadmap 17.3).

Needs ml/.venv. Refits the model exactly as `ml.train` does and refuses to write unless the refit
reproduces the newest committed `ml/results` run, so every stored rate comes from the model whose
backtest `/evals` shows. Writes to the live database, manual only, never CI. No Gemini quota;
EDGAR only for frames missing from ml/.cache.

Run from backend/:  ml/.venv/bin/python -m ml.score --dry-run
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

import pandas as pd

from app.models.schemas import LossBaseRate
from app.services import database, edgar
from ml import dataset, features, report, train

_DIGITS = 4


def score(published: report.LossModelRun) -> list[LossBaseRate] | None:
    """Rates for `dataset.LAST_YEAR`, or None when a refit no longer reproduces `published`."""
    refit, model, frames = train.fit(published.run_date)
    if refit != published:
        return None
    year = dataset.LAST_YEAR
    scored = features.scoring_rows(frames, year)
    x = pd.DataFrame([vector for _, vector in scored], columns=list(features.FEATURE_NAMES))
    probabilities = model.predict_proba(x)[:, 1]
    return [
        LossBaseRate(
            cik=edgar.unpad_cik(str(cik)),
            calendar_year=year,
            probability=round(float(p), _DIGITS),
            model_run=published.run_date,
        )
        for (cik, _), p in zip(scored, probabilities, strict=True)
    ]


def _print(rates: list[LossBaseRate]) -> None:
    print(f"{len(rates):,} companies scored from CY{rates[0].calendar_year} figures")
    deciles = Counter(min(int(r.probability * 10), 9) for r in rates)
    print(f"{'decile':<8}{'n':>7}")
    for decile, count in sorted(deciles.items()):
        print(f"{decile:<8}{count:>7,}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m ml.score")
    parser.add_argument("--dry-run", action="store_true", help="score and print; write nothing")
    args = parser.parse_args()

    published = report.load_runs()[-1]
    rates = score(published)
    if rates is None:
        sys.exit(
            f"A refit no longer reproduces ml/results/{published.run_date}.json, so its backtest"
            " would not describe these scores. Run `ml.train`, review and commit the new run,"
            " then score again."
        )
    if not rates:
        sys.exit(f"No CY{dataset.LAST_YEAR} net income frame to score.")
    _print(rates)
    if args.dry_run:
        print("\ndry run: nothing written")
        return
    deleted = database.replace_loss_base_rates(rates)
    print(f"\nwrote {len(rates):,} rows; deleted {deleted:,} from earlier years")


if __name__ == "__main__":
    main()
