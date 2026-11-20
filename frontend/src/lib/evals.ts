/** The eval run history behind `/evals` (roadmap 13.3).
 *
 * `src/data/eval-history.json` is written by the backend's `score` commands and
 * `ml.train` (`backend/evals/history_export.py`), and CI fails when it lags the
 * committed artifacts. These types mirror `RunSummary`, `QASummary` and
 * `ml/report.py`'s `LossModelRun`; they are not an API shape, so they stay out of
 * the contract-checked `types.ts`. Rates are fractions on the wire. */

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

export type LossModelName = "persistence" | "logistic_regression" | "xgboost";

export interface CalibrationRow {
  decile: number;
  count: number;
  mean_predicted: number;
  observed_rate: number;
}

export interface LossModelScore {
  name: LossModelName;
  pr_auc: number;
  brier: number;
  calibration: CalibrationRow[];
}

/** roadmap 17.1: every model scored on the same held-out years. */
export interface LossModelRun {
  run_date: string;
  train_years: number[];
  validation_years: number[];
  test_years: number[];
  rows: { train: number; validation: number; test: number };
  test_loss_rate: number;
  xgboost_best_iteration: number;
  models: LossModelScore[];
}

export interface EvalHistory {
  extraction: ExtractionRun[];
  qa: QARun[];
  loss_model: LossModelRun[];
}

export const LOSS_MODEL_LABELS: Record<LossModelName, string> = {
  persistence: "Persistence",
  logistic_regression: "Logistic regression",
  xgboost: "XGBoost",
};

export function newestRun<T extends { run_date: string }>(runs: T[]): T | null {
  return runs.reduce<T | null>(
    (newest, run) =>
      newest === null || run.run_date > newest.run_date ? run : newest,
    null,
  );
}

function scoreOf(run: LossModelRun, name: LossModelName): LossModelScore {
  const score = run.models.find((m) => m.name === name);
  if (!score) throw new Error(`loss_model run ${run.run_date} has no ${name}`);
  return score;
}

/** The sentence the page MUST print whichever way the backtest went: losing to
 * logistic regression or persistence is a valid outcome (roadmap 17.1). Higher
 * PR-AUC and lower Brier are better; a tie is not a win. */
export function lossModelVerdict(run: LossModelRun): string {
  const xgb = scoreOf(run, "xgboost");
  const others = run.models.filter((m) => m.name !== "xgboost");
  const winsPr = others.every((m) => xgb.pr_auc > m.pr_auc);
  const winsBrier = others.every((m) => xgb.brier < m.brier);
  if (winsPr && winsBrier) {
    return "XGBoost beat logistic regression and persistence on both measures.";
  }
  if (!winsPr && !winsBrier) {
    return "XGBoost did not beat the simpler models on either measure.";
  }
  return winsPr
    ? "XGBoost led on PR-AUC but not on Brier score."
    : "XGBoost led on Brier score but not on PR-AUC.";
}

/** Persistence predicts only 0 or 1, so its calibration is two bins: how often
 * a loss repeated, and how often a profit turned into one. */
export function persistenceRates(
  run: LossModelRun,
): { lossRepeats: number; profitTurns: number } | null {
  const bins = scoreOf(run, "persistence").calibration;
  const top = bins.find((b) => b.decile === 9);
  const bottom = bins.find((b) => b.decile === 0);
  if (!top || !bottom) return null;
  return { lossRepeats: top.observed_rate, profitTurns: bottom.observed_rate };
}

export interface CalibrationLine {
  decile: number;
  logistic: CalibrationRow | null;
  xgboost: CalibrationRow | null;
}

/** Both fitted models' calibration side by side, one line per decile either
 * one populated. */
export function calibrationLines(run: LossModelRun): CalibrationLine[] {
  const byDecile = (name: LossModelName) =>
    new Map(scoreOf(run, name).calibration.map((b) => [b.decile, b]));
  const logistic = byDecile("logistic_regression");
  const xgboost = byDecile("xgboost");
  const deciles = [...new Set([...logistic.keys(), ...xgboost.keys()])].sort(
    (a, b) => a - b,
  );
  return deciles.map((decile) => ({
    decile,
    logistic: logistic.get(decile) ?? null,
    xgboost: xgboost.get(decile) ?? null,
  }));
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
