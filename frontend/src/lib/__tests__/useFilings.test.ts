import { describe, expect, it } from "vitest";
import { FORM_FILTERS, formTypeFor, nounFor, type FormFilter } from "@/lib/useFilings";

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
