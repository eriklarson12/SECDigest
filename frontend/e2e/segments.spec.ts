import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS, ANALYSIS_SEGMENTED, JPM_SEGMENTS, mockApi } from "./mocks";

/** Revenue by segment and geography on the analysis page (roadmap 12.8). */

const CARD = { name: "Revenue breakdown" };

async function serve(page: Page, analysis: object) {
  await mockApi(page);
  // Later registration wins over mockApi's plain ANALYSIS.
  await page.route("**/api/analysis/1", (route) => route.fulfill({ json: analysis }));
  await page.goto("/analysis/1");
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
}

test("a 10-Q shows its quarter by segment, with shares of the total", async ({ page }) => {
  await serve(page, ANALYSIS_SEGMENTED);

  const card = page.getByRole("region", CARD);
  await expect(card).toContainText("Three months ended Jun 27, 2026");
  const table = card.getByRole("table", { name: "Revenue by segment" });
  await expect(table.getByRole("row", { name: /Americas/ })).toContainText("$45.78B");
  await expect(table.getByRole("row", { name: /Americas/ })).toContainText("41.8%");
  await expect(table.getByRole("row", { name: /Total/ })).toContainText("$109.42B");
  await expect(card.getByRole("table", { name: "Revenue by geography" })).toHaveCount(0);
});

test("reconciling rows sit below the segments so the total adds up", async ({ page }) => {
  await serve(page, { ...ANALYSIS, form_type: "10-K", segments: JPM_SEGMENTS });

  const card = page.getByRole("region", CARD);
  await expect(card).toContainText("Fiscal year ended Dec 31, 2025");
  const rows = card.getByRole("table", { name: "Revenue by segment" }).getByRole("row");
  await expect(rows).toHaveText([
    /Segment/,
    /Commercial and Investment Bank/,
    /Consumer Community Banking/,
    /Asset and Wealth Management/,
    /Corporate\s*\$7\.0\dB/,
    /Reconciling items\s*\$-3\.13B\s*-1\.7%/,
    /Total\s*\$182\.45B/,
  ]);
  const geography = card.getByRole("table", { name: "Revenue by geography" });
  await expect(geography.getByRole("row", { name: /International/ })).toHaveCount(0);
  await expect(geography.getByRole("row", { name: /North America/ })).toContainText("76.6%");
});

test("a filing without a breakdown renders no card", async ({ page }) => {
  await serve(page, ANALYSIS);
  await expect(page.getByText("▲ 5.5% year over year")).toBeVisible();
  await expect(page.getByRole("region", CARD)).toHaveCount(0);

  await serve(page, {
    ...ANALYSIS,
    segments: { period_start: "2026-01-01", period_end: "2026-03-28", segments: null, geography: null },
  });
  await expect(page.getByText("▲ 5.5% year over year")).toBeVisible();
  await expect(page.getByRole("region", CARD)).toHaveCount(0);
});

test("no horizontal scroll at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  // JPM's segment names are the longest labels the card has carried.
  await serve(page, { ...ANALYSIS, form_type: "10-K", segments: JPM_SEGMENTS });
  await expect(page.getByRole("region", CARD)).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
