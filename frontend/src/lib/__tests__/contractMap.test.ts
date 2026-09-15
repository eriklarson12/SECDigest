import { describe, expect, it } from "vitest";

import { SCHEMA_MAP, UNMAPPED } from "../contract/map.mjs";

/** `npm run contract` proves the two sides agree. These prove the map itself is coherent —
 * the failures a type check cannot see, because a malformed map silently checks less. */
describe("contract map", () => {
  it("never both maps and unmaps a schema", () => {
    const both = Object.keys(SCHEMA_MAP).filter((name) => name in UNMAPPED);
    expect(both).toEqual([]);
  });

  it("maps no frontend interface twice", () => {
    const targets = Object.values(SCHEMA_MAP);
    const duplicated = targets.filter((name, i) => targets.indexOf(name) !== i);
    expect(duplicated).toEqual([]);
  });

  it("gives every unmapped schema a reason", () => {
    for (const [name, reason] of Object.entries(UNMAPPED)) {
      expect(reason, `${name} needs a reason`).toBeTruthy();
    }
  });

  it("pins the one rename", () => {
    expect(SCHEMA_MAP.IndexStatusResponse).toBe("IndexStatus");
  });

  it("excludes frontend-local types, which are not API shapes", () => {
    expect(Object.values(SCHEMA_MAP)).not.toContain("WatchItem");
    expect(Object.values(SCHEMA_MAP)).not.toContain("TrendPoint");
  });
});
