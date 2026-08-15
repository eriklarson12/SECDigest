import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS, COMPANY, FILINGS, mockApi } from "./mocks";

const MSFT = { cik: "789019", ticker: "MSFT", name: "Microsoft Corporation" };

test("star from the dashboard adds the company to the watchlist", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await page.getByRole("button", { name: "Add AAPL to watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "Remove AAPL from watchlist" })
  ).toHaveAttribute("aria-pressed", "true");

  await page.goto("/watchlist");
  await expect(page.getByText("AAPL")).toBeVisible();
  await expect(page.getByText("Apple Inc.")).toBeVisible();

  await page.getByRole("button", { name: "Remove AAPL from watchlist" }).click();
  await expect(page.getByText("AAPL")).toBeHidden();
});

/** AAPL's latest filing matches its stored analysis (no badge); MSFT has a
 * filing but nothing analyzed (badge). */
async function mockWatchlistApi(page: Page) {
  await page.addInitScript(
    ([aapl, msft]) => {
      window.localStorage.setItem(
        "secdigest.watchlist",
        JSON.stringify([aapl, msft])
      );
    },
    [COMPANY, MSFT]
  );
  await page.route("**/api/filings/**", async (route) => {
    const isMsft = route.request().url().includes(MSFT.cik);
    await route.fulfill({
      json: isMsft
        ? [{ ...FILINGS[0], filing_date: "2026-06-15" }]
        : FILINGS,
    });
  });
  await page.route("**/api/analysis?*", async (route) => {
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    const analyses = ticker === COMPANY.ticker ? [ANALYSIS] : [];
    await route.fulfill({ json: { analyses, total: analyses.length } });
  });
}

test("new-filing badge appears only when EDGAR is ahead of the analysis", async ({
  page,
}) => {
  await mockWatchlistApi(page);
  await page.goto("/watchlist");

  const aaplCard = page
    .locator("div")
    .filter({ has: page.getByText("Apple Inc.") })
    .last();
  const msftCard = page
    .locator("div")
    .filter({ has: page.getByText("Microsoft Corporation") })
    .last();

  await expect(msftCard.getByText("New filing")).toBeVisible();
  await expect(msftCard.getByRole("link", { name: "Analyze now" })).toBeVisible();

  await expect(aaplCard.getByText("New filing")).toBeHidden();
  await expect(aaplCard.getByRole("link", { name: "View analysis" })).toHaveAttribute(
    "href",
    "/analysis/1"
  );
});
