import { test, expect } from "@playwright/test";
import { mockApi, mockWatchlistApi } from "./mocks";

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
