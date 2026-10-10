/** The eval run history behind `/evals` (roadmap 13.3).
 *
 * `src/data/eval-history.json` is written by the backend's `score` commands
 * (`backend/evals/history_export.py`) and CI fails when it lags the committed
 * artifacts. These types mirror `RunSummary` and `QASummary` there; they are not
 * an API shape, so they stay out of the contract-checked `types.ts`. Rates are
 * fractions on the wire. */

export interface ExtractionRun {
  run_date: string;
  model: string;
  max_filing_chars: number;
  filings: number;
  accuracy: number | null;
  scored: number;
  correct: number;
}

export interface QARun {
  run_date: string;
  model: string;
  retrieval_k: number;
  questions: number;
  grounded_rate: number | null;
  refusal_rate: number | null;
  hit_rate_at_k: number | null;
  citation_precision: number | null;
  citation_precision_v2: number | null;
}

export interface EvalHistory {
  extraction: ExtractionRun[];
  qa: QARun[];
}

export interface MetricPoint {
  date: string;
  /** Percent, 0 to 100, which is what `formatPercent` takes. */
  value: number;
}

type RateKey<T> = {
  [K in keyof T]: T[K] extends number | null ? K : never;
}[keyof T];

/** One metric across runs, oldest first. A run that predates the metric is
 * dropped rather than drawn as zero. */
export function series<T extends { run_date: string }>(
  runs: T[],
  key: RateKey<T>,
): MetricPoint[] {
  return runs
    .flatMap((run) => {
      const value = toPercent(run[key] as number | null);
      return value === null ? [] : [{ date: run.run_date, value }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Rates over question sets of different sizes are not strictly comparable,
 * so the page says so whenever the set changed between runs. */
export function questionCountChanged(runs: QARun[]): boolean {
  return new Set(runs.map((run) => run.questions)).size > 1;
}

/** A wire fraction as the percent `formatPercent` takes. */
export function toPercent(value: number | null): number | null {
  return value === null ? null : value * 100;
}
