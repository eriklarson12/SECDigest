import { test, expect } from "@playwright/test";
import { COMPANY, mockApi, mockWatchlistApi } from "./mocks";

test("star from the dashboard adds the company to the watchlist", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await page.getByRole("button", { name: "Add AAPL to watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "Remove AAPL from watchlist" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.goto("/watchlist");
  await expect(page.getByText("AAPL")).toBeVisible();
  await expect(page.getByText("Apple Inc.")).toBeVisible();

  await page
    .getByRole("button", { name: "Remove AAPL from watchlist" })
    .click();
  await expect(page.getByText("AAPL")).toBeHidden();
});

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
  await expect(
    msftCard.getByRole("link", { name: "Analyze now" }),
  ).toBeVisible();

  await expect(aaplCard.getByText("New filing")).toBeHidden();
  await expect(
    aaplCard.getByRole("link", { name: "View analysis" }),
  ).toHaveAttribute("href", "/analysis/1");
});

/** A rejected analyses lookup once returned `latestAnalysis: null`, which reads
 * exactly like "never analyzed" — so a company whose newest filing was already
 * analyzed got a "New filing" badge whenever that one request failed. */
test("a failed analysis lookup does not badge an up-to-date company", async ({
  page,
}) => {
  await mockWatchlistApi(page);
  // Later registration wins: AAPL's lookup fails, MSFT's still answers empty.
  await page.route("**/api/analysis?*", async (route) => {
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    if (ticker === COMPANY.ticker) {
      await route.fulfill({ status: 500, body: "boom" });
      return;
    }
    await route.fulfill({ json: { analyses: [], total: 0 } });
  });
  await page.goto("/watchlist");

  const aaplCard = page
    .locator("div")
    .filter({ has: page.getByText("Apple Inc.") })
    .last();

  // The filing itself still resolved, so the card is past its loading state
  await expect(aaplCard.getByText("May 2, 2026")).toBeVisible();
  await expect(aaplCard.getByText("New filing")).toBeHidden();

  // MSFT genuinely has nothing analyzed — that badge must survive
  await expect(page.getByText("New filing")).toHaveCount(1);
});
