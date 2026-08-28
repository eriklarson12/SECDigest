import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks";

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
