import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks";

/** roadmap 4.2 — the company page aggregates chart, filings, and analyses
 * for one ticker behind /company/{ticker}. */

test("company page aggregates chart, filings, and analyses", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await expect(page.getByText("Financial Trend")).toBeVisible();
  await expect(page.getByText("Recent Filings")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
  await expect(page.getByText("Past Analyses")).toBeVisible();
  await expect(page.getByRole("link", { name: "AAPL" }).first()).toBeVisible();

  // Analyzing from this page runs the same flow as the homepage
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page).toHaveURL(/\/analysis\/1$/);
});

test("invalid ticker format shows the empty state", async ({ page }) => {
  await mockApi(page);
  await page.goto("/company/1AAPL");
  await expect(page.getByText("Invalid ticker")).toBeVisible();
});

test("unknown ticker shows the empty state", async ({ page }) => {
  // mockApi's search fixture only ever resolves to AAPL, so a well-formed
  // ticker it doesn't return exercises the "no exact match" branch.
  await mockApi(page);
  await page.goto("/company/ZZZZ");
  await expect(page.getByText("Unknown ticker")).toBeVisible();
});

/** roadmap 8.1 — the SEC industry classification, named as the SEC's own code
 * rather than presented as a neutral industry label. */

test("company page shows the SEC industry classification", async ({ page }) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await expect(page.getByTestId("industry-badge")).toHaveText(
    "SIC 3571 · Electronic Computers",
  );
});

test("the company page industry line links to the filtered history", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await page.getByTestId("industry-badge").getByRole("link").click();

  await expect(page).toHaveURL(/\/history\?sic=3571$/);
});

test("an unclassified filer renders no industry line", async ({ page }) => {
  await mockApi(page);
  // EDGAR leaves roughly a quarter of listed filers unclassified.
  await page.route("**/api/companies/*/profile", (route) =>
    route.fulfill({
      json: { cik: "0000320193", sic: null, sic_description: null, owner_org: null },
    }),
  );
  await page.goto("/company/AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByTestId("industry-badge")).toHaveCount(0);
});

test("the industry line does not overflow a 375px viewport", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/companies/*/profile", (route) =>
    route.fulfill({
      json: {
        cik: "0000320193",
        // One of the longest descriptions EDGAR issues.
        sic: "7372",
        sic_description: "Services-Computer Programming, Data Processing, Etc.",
        owner_org: "06 Technology",
      },
    }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/company/AAPL");

  await expect(page.getByTestId("industry-badge")).toBeVisible();
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
