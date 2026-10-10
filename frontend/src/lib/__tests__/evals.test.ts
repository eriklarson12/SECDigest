import { describe, expect, it } from "vitest";
import {
  questionCountChanged,
  series,
  toPercent,
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
