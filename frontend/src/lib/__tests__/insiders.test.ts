import { describe, expect, it } from "vitest";

import { formatShareCount } from "../format";
import { codeLabel, emptyLine, netLine, plannedLine, sourceLine } from "../insiders";
import type { InsiderActivity, InsiderTransaction } from "../types";

const SALE: InsiderTransaction = {
  accession_number: "0001140361-26-038307",
  filing_date: "2026-10-01",
  transaction_date: "2026-09-29",
  owner_name: "Newstead Jennifer",
  role: "SVP, GC and Government Affairs",
  code: "S",
  shares: 2399,
  price: 336.18,
  value: 806495.82,
  planned: true,
};

function activity(over: Partial<InsiderActivity> = {}): InsiderActivity {
  return {
    cik: "0000320193",
    window_days: 90,
    filings_scanned: 15,
    filings_failed: 0,
    filings_without_trades: 7,
    truncated: false,
    net_shares: -13430,
    net_value: -4342254.52,
    unpriced_count: 0,
    transactions: [SALE],
    ...over,
  };
}

describe("formatShareCount", () => {
  it("groups and drops the sign", () => {
    expect(formatShareCount(-13430)).toBe("13,430");
    expect(formatShareCount(1234567.6)).toBe("1,234,568");
  });
});

describe("netLine", () => {
  it("reads a net sale with its arrow and dollar figure", () => {
    expect(netLine(activity())).toBe("▼ Net sold 13,430 shares ($4.3M)");
  });

  it("reads a net purchase", () => {
    expect(netLine(activity({ net_shares: 4770, net_value: 249852.6 }))).toBe(
      "▲ Net bought 4,770 shares ($249,853)",
    );
  });

  it("omits the dollars when no trade had a price", () => {
    expect(netLine(activity({ net_shares: 1, net_value: 0 }))).toBe("▲ Net bought 1 share");
  });

  it("says when buys and sells cancel out", () => {
    expect(netLine(activity({ net_shares: 0, net_value: 0 }))).toBe(
      "Buys and sells net to zero shares",
    );
  });
});

describe("plannedLine", () => {
  it("counts trades under a 10b5-1 plan", () => {
    const two = activity({ transactions: [SALE, { ...SALE, planned: false }] });
    expect(plannedLine(two)).toBe(
      "1 of 2 trades was scheduled in advance under a Rule 10b5-1 plan.",
    );
  });

  it("is null when none were planned", () => {
    expect(plannedLine(activity({ transactions: [{ ...SALE, planned: false }] }))).toBeNull();
  });
});

describe("sourceLine", () => {
  it("names the scan and its gaps", () => {
    expect(sourceLine(activity())).toBe(
      "From the 15 Form 4s filed in the last 90 days. Open-market trades only.",
    );
    expect(
      sourceLine(
        activity({ filings_scanned: 1, truncated: true, filings_failed: 2, unpriced_count: 1 }),
      ),
    ).toBe(
      "From the 1 Form 4 filed in the last 90 days. Open-market trades only. " +
        "Only the latest filings were read, so older ones may be missing. " +
        "2 filings could not be read. " +
        "The dollar figure leaves out 1 trade filed without a price.",
    );
  });
});

describe("emptyLine", () => {
  it("counts the Form 4s that were not trades", () => {
    expect(emptyLine(activity({ filings_scanned: 13, filings_without_trades: 13, transactions: [] }))).toBe(
      "No open-market buys or sells in the last 90 days. 13 Form 4s reported other " +
        "transactions, such as grants, option exercises or tax withholding.",
    );
  });

  it("says when nothing was filed", () => {
    expect(emptyLine(activity({ filings_scanned: 0, filings_without_trades: 0, transactions: [] }))).toBe(
      "No Form 4s filed in the last 90 days.",
    );
  });
});

describe("codeLabel", () => {
  it("names the two codes", () => {
    expect(codeLabel("P")).toBe("Buy");
    expect(codeLabel("S")).toBe("Sale");
  });
});
