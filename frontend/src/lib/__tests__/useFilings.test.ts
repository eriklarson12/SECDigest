import { describe, expect, it } from "vitest";
import {
  FORM_FILTERS,
  formTypeFor,
  nounFor,
  requestFormType,
  type FormFilter,
} from "@/lib/useFilings";

describe("formTypeFor", () => {
  it("expands the default filter to both form types", () => {
    expect(formTypeFor("all")).toBe("10-K,10-Q");
  });

  it("sends a single form type through unchanged", () => {
    expect(formTypeFor("10-K")).toBe("10-K");
    expect(formTypeFor("10-Q")).toBe("10-Q");
  });
});

describe("nounFor", () => {
  it("names both form types for the default filter", () => {
    expect(nounFor("all")).toBe("10-K or 10-Q");
  });

  it("names just the active form type otherwise", () => {
    expect(nounFor("10-Q")).toBe("10-Q");
  });
});

describe("FORM_FILTERS", () => {
  it("covers every filter, so neither lookup can miss", () => {
    const filters: FormFilter[] = ["all", "10-K", "10-Q"];
    expect(FORM_FILTERS.map((f) => f.value)).toEqual(filters);
  });
});

describe("requestFormType", () => {
  it("leaves the request untouched when a caller wants no events", () => {
    // FilingSelector on the homepage takes this path; nothing about it may move.
    const filters: FormFilter[] = ["all", "10-K", "10-Q"];
    for (const f of filters) {
      expect(requestFormType(f, false)).toBe(formTypeFor(f));
    }
  });

  it("adds the event forms to the default filter", () => {
    expect(requestFormType("all", true)).toBe("10-K,10-Q,8-K,8-K/A");
  });

  it("keeps the event forms in every filter state", () => {
    // The events section is not filtered by the periodic-form control, so clicking 10-K
    // must not empty it. One wider request, never a second one.
    expect(requestFormType("10-K", true)).toBe("10-K,8-K,8-K/A");
    expect(requestFormType("10-Q", true)).toBe("10-Q,8-K,8-K/A");
  });

  it("names amendments explicitly, because EDGAR matches form types exactly", () => {
    // `8-K` alone does not return `8-K/A`, and AAPL's newest event is an amendment.
    expect(requestFormType("all", true)).toContain("8-K/A");
  });
});
