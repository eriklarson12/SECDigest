import { test, expect } from "@playwright/test";
import { ANALYSIS, COMPANY, FILINGS, mockApi } from "./mocks";

/** roadmap 4.6 — the analysis page flags that EDGAR has moved past this filing. */

const banner = /A newer 10-K was filed/;

test("a stale analysis links to the company's filings", async ({ page }) => {
  await mockApi(page);
  // Later registration wins: EDGAR is three months ahead of the stored analysis.
  await page.route("**/api/filings/**", (route) =>
    route.fulfill({
      json: [
        {
          ...FILINGS[0],
          accession_number: "0000320193-26-000112",
          form_type: "10-K",
          filing_date: "2026-08-14",
        },
      ],
    }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: banner });
  await expect(notice).toBeVisible();
  await expect(
    notice.getByRole("link", { name: /analyze it from the company/ }),
  ).toHaveAttribute("href", `/company/${COMPANY.ticker}`);
});

test("an up-to-date analysis shows no banner", async ({ page }) => {
  // The shared fixtures agree: FILINGS[0] and ANALYSIS share a filing_date.
  expect(FILINGS[0].filing_date).toBe(ANALYSIS.filing_date);
  await mockApi(page);
  await page.goto("/analysis/1");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByText(/A newer .* was filed/)).toHaveCount(0);
});
