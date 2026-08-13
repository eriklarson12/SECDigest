import type { Page } from "@playwright/test";

/** Shared API fixtures — every spec mocks the backend at the network layer. */

export const COMPANY = { cik: "320193", ticker: "AAPL", name: "Apple Inc." };

export const FILINGS = [
  {
    accession_number: "0000320193-26-000057",
    form_type: "10-Q",
    filing_date: "2026-05-02",
    primary_document: "aapl-q2.htm",
    primary_doc_description: "10-Q",
  },
];

export const ANALYSIS = {
  id: 1,
  accession_number: "000032019326000057",
  cik: COMPANY.cik,
  ticker: COMPANY.ticker,
  company_name: COMPANY.name,
  form_type: "10-Q",
  filing_date: "2026-05-02",
  revenue_current: 1_000_000_000,
  revenue_yoy_change_pct: 5.5,
  net_income_current: 200_000_000,
  net_income_yoy_change_pct: -1.2,
  risk_factors: ["Supply chain concentration risk."],
  management_guidance: "Management expects continued growth.",
  summary: "Revenue grew 5.5% year over year.",
  created_at: "2026-07-04T00:00:00+00:00",
};

export const FINANCIALS = {
  cik: COMPANY.cik,
  years: [
    {
      fiscal_year: 2023,
      revenue: 900_000_000,
      net_income: 150_000_000,
      eps_diluted: 5.89,
      operating_cash_flow: 300_000_000,
      cash: 60_000_000,
      total_assets: 1_800_000_000,
      stockholders_equity: 700_000_000,
    },
    {
      fiscal_year: 2024,
      revenue: 950_000_000,
      net_income: 180_000_000,
      eps_diluted: 6.11,
      operating_cash_flow: 320_000_000,
      cash: 65_000_000,
      total_assets: 1_900_000_000,
      stockholders_equity: 750_000_000,
    },
    {
      fiscal_year: 2025,
      revenue: 1_000_000_000,
      net_income: 200_000_000,
      eps_diluted: 6.42,
      operating_cash_flow: 350_000_000,
      cash: 70_000_000,
      total_assets: 2_000_000_000,
      stockholders_equity: 800_000_000,
    },
  ],
  quarters: [
    { period_end: "2025-03-29", revenue: 240_000_000, net_income: 45_000_000 },
    { period_end: "2025-06-28", revenue: 250_000_000, net_income: 48_000_000 },
    { period_end: "2025-09-27", revenue: 255_000_000, net_income: 50_000_000 },
    { period_end: "2025-12-27", revenue: 260_000_000, net_income: 52_000_000 },
  ],
};

export const ASK_ANSWER = {
  answer: "Revenue grew on iPhone demand (excerpt 1).",
  sources: [
    { chunk_index: 4, excerpt: "iPhone net sales increased 6% year over year." },
    { chunk_index: 9, excerpt: "Services revenue reached an all-time high." },
  ],
  unit_scale: "Amounts in millions, except per share data.",
};

/** A filing that never declares a scale — the caption is omitted, not blanked. */
export const ASK_ANSWER_NO_SCALE = { ...ASK_ANSWER, unit_scale: null };

/** Palantir's shape: the filing reports in thousands and the model converted
 * 931,767 to "$932 million" rather than restating it. The caption has to read
 * as a fact about the filing, or it looks like it contradicts the answer. */
export const ASK_ANSWER_CONVERTED = {
  ...ASK_ANSWER,
  answer: "Total revenue increased by $932 million, or 93% (excerpt 2).",
  unit_scale: "In thousands.",
};

export const INDEX_COMPLETE = {
  state: "complete",
  chunks_indexed: 102,
  chunks_total: 102,
};

export const INDEX_IN_PROGRESS = {
  state: "indexing",
  chunks_indexed: 24,
  chunks_total: 102,
};

export async function mockApi(page: Page) {
  // Later registrations win in Playwright, so go general → specific.
  await page.route("**/api/analysis*", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: ANALYSIS });
    } else {
      await route.fulfill({ json: { analyses: [ANALYSIS], total: 1 } });
    }
  });
  await page.route("**/api/analysis/1", (route) => route.fulfill({ json: ANALYSIS }));
  // `*` does not cross `/` in Playwright globs, so the routes above never see
  // this path — the ask endpoint needs its own pattern.
  await page.route("**/api/analysis/*/ask", (route) =>
    route.fulfill({ json: ASK_ANSWER })
  );
  // Fully indexed by default; tests that care about the ramp-up re-route this.
  await page.route("**/api/analysis/*/index-status", (route) =>
    route.fulfill({ json: INDEX_COMPLETE })
  );
  await page.route("**/api/companies/search*", (route) =>
    route.fulfill({ json: [COMPANY] })
  );
  await page.route("**/api/filings/**", (route) => route.fulfill({ json: FILINGS }));
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: FINANCIALS })
  );
}
