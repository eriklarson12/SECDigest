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
