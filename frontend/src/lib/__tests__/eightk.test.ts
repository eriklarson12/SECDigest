import { describe, expect, it } from "vitest";

import {
  EVENT_FORMS,
  ITEM_LABELS,
  eventSummary,
  isEvent,
  itemLabel,
  splitFilings,
} from "@/lib/eightk";
import type { Filing } from "@/lib/types";

function filing(overrides: Partial<Filing> = {}): Filing {
  return {
    accession_number: "0000320193-26-000057",
    form_type: "10-Q",
    filing_date: "2026-05-02",
    primary_document: "aapl-q2.htm",
    primary_doc_description: "10-Q",
    items: [],
    ...overrides,
  };
}

describe("itemLabel", () => {
  it("names the codes a reader actually meets", () => {
    expect(itemLabel("2.02")).toBe("Results of Operations");
    expect(itemLabel("5.02")).toBe("Departure or Election of Directors or Officers");
    expect(itemLabel("5.07")).toBe("Submission of Matters to a Vote");
    expect(itemLabel("8.01")).toBe("Other Events");
    expect(itemLabel("9.01")).toBe("Exhibits");
  });

  it("renders an unmapped code rather than dropping it", () => {
    // The SEC adds items without notice — 1.05 arrived with the 2023 cybersecurity rules.
    // A silently missing event reads as a filing that said nothing.
    expect(itemLabel("7.02")).toBe("Item 7.02");
    expect(itemLabel("6.03")).toBe("Item 6.03");
  });

  it("covers every code measured against live EDGAR", () => {
    // Observed across AAPL, GE, XOM, PFE and SMCI on 2026-09-06. A miss here is a real
    // gap in the map, not a failing fixture.
    const measured = [
      "1.01", "1.02", "2.01", "2.02", "2.03", "2.04", "2.05", "2.06",
      "3.01", "3.02", "3.03", "4.01", "4.02", "5.02", "5.03", "5.04",
      "5.05", "5.07", "5.08", "7.01", "8.01", "9.01",
    ];
    expect(measured.filter((c) => !(c in ITEM_LABELS))).toEqual([]);
  });

  it("keeps every label short enough to sit on one line", () => {
    // These render as a wrapping middot line beside a date at 375px. A caption at the SEC's
    // own length (140+ characters) would push the row to five lines.
    const tooLong = Object.entries(ITEM_LABELS).filter(([, l]) => l.length > 50);
    expect(tooLong).toEqual([]);
  });
});

describe("eventSummary", () => {
  it("joins the labels with a middot", () => {
    expect(eventSummary(["2.02", "9.01"])).toBe("Results of Operations · Exhibits");
  });

  it("sorts so Exhibits never leads", () => {
    // 9.01 is on 83% of 8-Ks and says nothing about what happened, so it must not be the
    // first thing read. Sorting is what keeps it last, whatever order the row arrives in.
    expect(eventSummary(["9.01", "2.02"])).toBe("Results of Operations · Exhibits");
  });

  it("does not mutate the array it was given", () => {
    const items = ["9.01", "2.02"];
    eventSummary(items);
    expect(items).toEqual(["9.01", "2.02"]);
  });

  it("is null for a filing with no codes, not an empty string", () => {
    // The row still renders — date and form badge — rather than vanishing. That is the
    // whole degradation path for a filer whose items EDGAR left blank.
    expect(eventSummary([])).toBeNull();
  });

  it("carries an unmapped code through into the line", () => {
    expect(eventSummary(["7.02", "9.01"])).toBe("Item 7.02 · Exhibits");
  });
});

describe("isEvent", () => {
  it("counts amendments, which are events and sometimes the newest one", () => {
    expect(isEvent("8-K")).toBe(true);
    expect(isEvent("8-K/A")).toBe(true);
  });

  it("counts no periodic form, amended or not", () => {
    expect(isEvent("10-K")).toBe(false);
    expect(isEvent("10-K/A")).toBe(false);
    expect(isEvent("10-Q")).toBe(false);
  });

  it("agrees with the forms actually requested", () => {
    expect(EVENT_FORMS.every(isEvent)).toBe(true);
  });
});

describe("splitFilings", () => {
  it("routes each form to its own section", () => {
    const { periodic, events } = splitFilings([
      filing({ accession_number: "a", form_type: "10-Q" }),
      filing({ accession_number: "b", form_type: "8-K", items: ["2.02"] }),
      filing({ accession_number: "c", form_type: "8-K/A", items: ["5.02"] }),
      filing({ accession_number: "d", form_type: "10-K/A" }),
    ]);
    expect(periodic.map((f) => f.accession_number)).toEqual(["a", "d"]);
    expect(events.map((f) => f.accession_number)).toEqual(["b", "c"]);
  });

  it("keeps the order the backend returned", () => {
    const { events } = splitFilings([
      filing({ accession_number: "new", form_type: "8-K/A", filing_date: "2026-09-01" }),
      filing({ accession_number: "old", form_type: "8-K", filing_date: "2026-07-30" }),
    ]);
    expect(events.map((f) => f.accession_number)).toEqual(["new", "old"]);
  });

  it("caps both sections at ten", () => {
    // The response is deliberately over-fetched — 100 rows, because reaching 10 periodic
    // filings means walking past up to 57 8-Ks. Neither section renders the overflow.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) =>
        filing({ accession_number: `q${i}`, form_type: "10-Q" }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        filing({ accession_number: `e${i}`, form_type: "8-K", items: ["8.01"] }),
      ),
    ];
    const { periodic, events } = splitFilings(rows);
    expect(periodic).toHaveLength(10);
    expect(events).toHaveLength(10);
  });

  it("is empty on both sides for a company with no filings", () => {
    expect(splitFilings([])).toEqual({ periodic: [], events: [] });
  });
});
