import { describe, expect, it } from "vitest";
import { withParam } from "@/lib/query";

describe("withParam", () => {
  it("adds a param that was absent", () => {
    const params = new URLSearchParams("sic=7372");
    expect(withParam("/history", params, "owner_org", "02 Finance")).toBe(
      "/history?sic=7372&owner_org=02+Finance",
    );
  });

  it("replaces a param that was already set, without duplicating it", () => {
    const params = new URLSearchParams("owner_org=02+Finance");
    expect(withParam("/history", params, "owner_org", "06 Technology")).toBe(
      "/history?owner_org=06+Technology",
    );
  });

  it("removes a param on a null value", () => {
    const params = new URLSearchParams("sic=7372&owner_org=02+Finance");
    expect(withParam("/history", params, "owner_org", null)).toBe(
      "/history?sic=7372",
    );
  });

  // The regression `clearSicFilter` shipped: clearing one filter navigated to a bare
  // "/history" and silently took the other with it. Both directions are asserted.
  it("leaves every other param standing, setting and clearing alike", () => {
    const params = new URLSearchParams("sic=7372&owner_org=02+Finance&a=1");
    expect(withParam("/history", params, "sic", null)).toBe(
      "/history?owner_org=02+Finance&a=1",
    );
    expect(withParam("/history", params, "sic", "3571")).toBe(
      "/history?sic=3571&owner_org=02+Finance&a=1",
    );
  });

  it("encodes a value with a space so it round-trips", () => {
    const url = withParam(
      "/history",
      new URLSearchParams(),
      "owner_org",
      "06 Technology",
    );
    expect(url).toBe("/history?owner_org=06+Technology");
    expect(new URLSearchParams(url.split("?")[1]).get("owner_org")).toBe(
      "06 Technology",
    );
  });

  it("returns the bare path when nothing is left", () => {
    expect(
      withParam("/history", new URLSearchParams("sic=7372"), "sic", null),
    ).toBe("/history");
    expect(withParam("/history", new URLSearchParams(), "sic", null)).toBe(
      "/history",
    );
  });

  it("accepts anything that stringifies, not only a URLSearchParams", () => {
    expect(
      withParam(
        "/history",
        { toString: () => "sic=7372" },
        "owner_org",
        "unclassified",
      ),
    ).toBe("/history?sic=7372&owner_org=unclassified");
  });
});
