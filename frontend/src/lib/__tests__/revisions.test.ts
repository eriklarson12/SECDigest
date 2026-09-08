import { describe, it, expect } from "vitest";
import {
  METRIC_LABELS,
  formatRevisionDelta,
  metricLabel,
  revisionArrow,
} from "../revisions";

describe("metricLabel", () => {
  it("labels every metric the backend emits", () => {
    expect(Object.keys(METRIC_LABELS)).toEqual([
      "revenue",
      "net_income",
      "operating_cash_flow",
    ]);
    expect(metricLabel("net_income")).toBe("Net Income");
    expect(metricLabel("operating_cash_flow")).toBe("Operating Cash Flow");
  });

  it("renders an unmapped metric as its own key rather than dropping it", () => {
    expect(metricLabel("eps_diluted")).toBe("eps_diluted");
  });
});

describe("formatRevisionDelta", () => {
  it("signs a downward revision", () => {
    expect(formatRevisionDelta(-61.94)).toBe("-61.9%");
  });

  it("signs an upward revision explicitly", () => {
    expect(formatRevisionDelta(22.26)).toBe("+22.3%");
  });

  it("keeps one decimal on a whole number", () => {
    expect(formatRevisionDelta(5)).toBe("+5.0%");
  });
});

describe("revisionArrow", () => {
  it("pairs the direction with the sign rather than a colour", () => {
    expect(revisionArrow(3)).toBe("▲");
    expect(revisionArrow(-3)).toBe("▼");
  });
});
