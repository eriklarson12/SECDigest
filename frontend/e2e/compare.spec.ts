import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS, COMPANY } from "./mocks";

const MSFT = { cik: "789019", ticker: "MSFT", name: "Microsoft Corporation" };

/** Search resolves either company; only AAPL has a stored analysis. */
async function mockCompareApi(page: Page) {
  await page.route("**/api/companies/search*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const matches = [COMPANY, MSFT].filter((c) =>
      c.ticker.startsWith(q.toUpperCase())
    );
    await route.fulfill({ json: matches });
  });
  await page.route("**/api/analysis?*", async (route) => {
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    const analyses = ticker === COMPANY.ticker ? [ANALYSIS] : [];
    await route.fulfill({ json: { analyses, total: analyses.length } });
  });
}

test("compare flow: pick two tickers, URL reflects the pair", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare");

  const boxes = page.getByRole("combobox");
  await boxes.nth(0).fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page).toHaveURL(/\/compare\?a=AAPL$/);
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByText("Apple Inc.")).toBeVisible();

  await boxes.nth(1).fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();
  await expect(page).toHaveURL(/\/compare\?a=AAPL&b=MSFT$/);
  await expect(page.getByText("No analysis yet for MSFT")).toBeVisible();
});

test("shared compare URL reproduces the view", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare?a=AAPL&b=AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toHaveCount(2);
  await expect(page.getByText("Apple Inc.")).toHaveCount(2);
});

test("invalid URL params degrade to the empty pickers", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare?a=..%2Fetc&b=");

  await expect(page.getByText("Search a ticker to fill this side.")).toHaveCount(2);
});
