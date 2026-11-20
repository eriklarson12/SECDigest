import { describe, expect, it } from "vitest";
import {
  calibrationLines,
  lossModelVerdict,
  newestRun,
  persistenceRates,
  questionCountChanged,
  series,
  toPercent,
  type LossModelName,
  type LossModelRun,
  type QARun,
} from "@/lib/evals";

function run(run_date: string, overrides: Partial<QARun> = {}): QARun {
  return {
    run_date,
    model: "gemini-3.5-flash-lite",
    retrieval_k: 6,
    questions: 20,
    grounded_rate: 1,
    refusal_rate: 1,
    hit_rate_at_k: 0.85,
    citation_precision: 0.4,
    citation_precision_v2: 0.475,
    ...overrides,
  };
}

describe("series", () => {
  it("converts fractions to percent, oldest first", () => {
    const points = series(
      [run("2026-10-08"), run("2026-09-14", { hit_rate_at_k: 0.8666 })],
      "hit_rate_at_k",
    );
    expect(points.map((p) => p.date)).toEqual(["2026-09-14", "2026-10-08"]);
    expect(points[0].value).toBeCloseTo(86.66);
    expect(points[1].value).toBeCloseTo(85);
  });

  it("drops a run that predates the metric instead of drawing zero", () => {
    const points = series(
      [run("2026-09-14", { citation_precision_v2: null }), run("2026-10-08")],
      "citation_precision_v2",
    );
    expect(points).toEqual([{ date: "2026-10-08", value: 47.5 }]);
  });
});

describe("questionCountChanged", () => {
  it("is false for one run or a constant set", () => {
    expect(questionCountChanged([run("2026-09-14")])).toBe(false);
    expect(questionCountChanged([run("2026-09-14"), run("2026-10-08")])).toBe(false);
  });

  it("is true once the set grows", () => {
    expect(
      questionCountChanged([run("2026-09-14"), run("2026-10-08", { questions: 26 })]),
    ).toBe(true);
  });
});

describe("toPercent", () => {
  it("keeps null as null", () => {
    expect(toPercent(null)).toBeNull();
    expect(toPercent(0.5)).toBe(50);
  });
});

function bin(decile: number, observed_rate = 0.5) {
  return {
    decile,
    count: 10,
    mean_predicted: decile / 10 + 0.05,
    observed_rate,
  };
}

function lossRun(
  scores: Record<LossModelName, [number, number]>,
  run_date = "2026-11-20",
): LossModelRun {
  return {
    run_date,
    train_years: [2011, 2020],
    validation_years: [2021, 2022],
    test_years: [2023, 2024],
    rows: { train: 100, validation: 20, test: 20 },
    test_loss_rate: 0.5,
    xgboost_best_iteration: 42,
    models: (Object.keys(scores) as LossModelName[]).map((name) => ({
      name,
      pr_auc: scores[name][0],
      brier: scores[name][1],
      calibration:
        name === "persistence"
          ? [bin(0, 0.16), bin(9, 0.85)]
          : name === "xgboost"
            ? [bin(0), bin(9)]
            : [bin(0), bin(4), bin(9)],
    })),
  };
}

describe("lossModelVerdict", () => {
  it("says so when XGBoost wins on both measures", () => {
    const run = lossRun({
      persistence: [0.79, 0.158],
      logistic_regression: [0.89, 0.12],
      xgboost: [0.9, 0.115],
    });
    expect(lossModelVerdict(run)).toBe(
      "XGBoost beat logistic regression and persistence on both measures.",
    );
  });

  it("says so when XGBoost loses, which is a valid outcome", () => {
    const run = lossRun({
      persistence: [0.79, 0.158],
      logistic_regression: [0.9, 0.11],
      xgboost: [0.89, 0.12],
    });
    expect(lossModelVerdict(run)).toBe(
      "XGBoost did not beat the simpler models on either measure.",
    );
  });

  it("names the measure XGBoost led on when the result is split", () => {
    const run = lossRun({
      persistence: [0.79, 0.158],
      logistic_regression: [0.89, 0.11],
      xgboost: [0.9, 0.12],
    });
    expect(lossModelVerdict(run)).toBe(
      "XGBoost led on PR-AUC but not on Brier score.",
    );
  });

  it("does not count a tie as a win", () => {
    const run = lossRun({
      persistence: [0.79, 0.158],
      logistic_regression: [0.9, 0.12],
      xgboost: [0.9, 0.115],
    });
    expect(lossModelVerdict(run)).toBe(
      "XGBoost led on Brier score but not on PR-AUC.",
    );
  });
});

describe("persistenceRates", () => {
  it("reads the two bins persistence can fill", () => {
    const run = lossRun({
      persistence: [0.79, 0.158],
      logistic_regression: [0.89, 0.12],
      xgboost: [0.9, 0.115],
    });
    expect(persistenceRates(run)).toEqual({
      lossRepeats: 0.85,
      profitTurns: 0.16,
    });
  });
});

describe("calibrationLines", () => {
  it("lines both models up by decile and leaves a gap where one is empty", () => {
    const run = lossRun({
      persistence: [0.79, 0.158],
      logistic_regression: [0.89, 0.12],
      xgboost: [0.9, 0.115],
    });
    const lines = calibrationLines(run);
    expect(lines.map((l) => l.decile)).toEqual([0, 4, 9]);
    expect(lines[1].logistic?.decile).toBe(4);
    expect(lines[1].xgboost).toBeNull();
  });
});

describe("newestRun", () => {
  it("picks the latest date and is null with no runs", () => {
    const scores = {
      persistence: [0.79, 0.158],
      logistic_regression: [0.89, 0.12],
      xgboost: [0.9, 0.115],
    } as Record<LossModelName, [number, number]>;
    expect(
      newestRun([lossRun(scores, "2026-11-20"), lossRun(scores, "2027-01-05")])
        ?.run_date,
    ).toBe("2027-01-05");
    expect(newestRun([])).toBeNull();
  });
});
