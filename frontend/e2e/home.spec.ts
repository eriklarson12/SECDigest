import { test, expect } from "@playwright/test";
import { mockApi, mockWatchlistApi } from "./mocks";

/** Homepage surfaces: the recent-analyses list and the YoY delta it renders
 * from the same payload it already had (roadmap Tier 7). */

test("recent analyses rows carry the YoY revenue delta", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const row = page.getByRole("link", { name: /Apple Inc\./ });
  await expect(row).toContainText("$1.00B");
  // ANALYSIS.revenue_yoy_change_pct is 5.5 — positive, so ▲ and no minus sign
  await expect(row).toContainText("▲ 5.5%");
});

test("the insight card keeps its delta after the extraction", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await expect(page.getByText("▲ 5.5% year over year")).toBeVisible();
  // net_income_yoy_change_pct is -1.2 — the glyph flips and the sign is dropped
  await expect(page.getByText("▼ 1.2% year over year")).toBeVisible();
});

/** The delta adds a fourth column to a row that had three at 375px, which is
 * the width the design rules call out. Guard it rather than eyeballing it. */
test("the recent-analyses row does not overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("link", { name: /Apple Inc\./ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("the watchlist strip counts watched companies and newer filings", async ({
  page,
}) => {
  await mockWatchlistApi(page);
  await page.goto("/");

  const strip = page.getByRole("region", { name: "Watchlist" });
  await expect(strip.getByRole("link", { name: "Watching 2" })).toBeVisible();
  // MSFT filed 2026-06-15 with nothing analyzed; AAPL is up to date
  await expect(strip).toContainText("1 has filings newer than your analysis");
});

test("an empty watchlist renders no strip at all", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("region", { name: "Watchlist" })).toHaveCount(0);
});

/** The reason lib/watchlistStatus exists: two surfaces, two requests per
 * company, and a 30/min limit on /api/filings. Uncached, this walk costs four
 * filings calls; the cache makes it two. */
test("navigating to the watchlist reuses the strip's lookups", async ({
  page,
}) => {
  // page.on observes every request; a counting page.route would have to be
  // registered after the fulfilling one and fall back to it, which is fragile.
  const filingsCalls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/filings/")) filingsCalls.push(req.url());
  });
  await mockWatchlistApi(page);
  await page.goto("/");

  const strip = page.getByRole("region", { name: "Watchlist" });
  await expect(strip).toContainText("1 has filings newer than your analysis");
  expect(filingsCalls).toHaveLength(2);

  await strip.getByRole("link", { name: "Watching 2" }).click();
  await expect(page.getByText("Microsoft Corporation")).toBeVisible();
  await expect(page.getByText("New filing")).toBeVisible();

  expect(filingsCalls).toHaveLength(2);
});
