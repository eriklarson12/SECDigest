import { describe, expect, it } from "vitest";
import { edgarFilingIndexUrl } from "@/lib/edgar";

describe("edgarFilingIndexUrl", () => {
  it("builds the archives index URL with unpadded CIK and dashless accession", () => {
    expect(edgarFilingIndexUrl("320193", "000032019325000057")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000057/"
    );
  });

  it("strips leading zeros from a padded CIK", () => {
    expect(edgarFilingIndexUrl("0000320193", "000032019325000057")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000057/"
    );
  });

  it("removes dashes from a dashed accession number", () => {
    expect(edgarFilingIndexUrl("320193", "0000320193-25-000057")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000057/"
    );
  });
});
