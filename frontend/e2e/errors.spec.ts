import { test, expect } from "@playwright/test";
import { ANALYSIS, mockApi } from "./mocks";

test("analyze 503 shows friendly copy, retrying recovers", async ({ page }) => {
  await mockApi(page);
  // First POST fails at capacity; the retry succeeds (later routes win, and
  // this pattern has no query string so the GET list keeps its mock).
  let posts = 0;
  await page.route("**/api/analysis", async (route) => {
    posts++;
    if (posts === 1) {
      await route.fulfill({ status: 503, json: { detail: "quota exhausted" } });
    } else {
      await route.fulfill({ json: ANALYSIS });
    }
  });

  await page.goto("/");
  await page.getByRole("combobox").fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await page.getByRole("button", { name: "Analyze" }).click();

  // Friendly capacity copy (exact string from lib/api.ts), never the raw
  // detail. Filter: Next's route announcer is also role=alert.
  await expect(
    page.getByRole("alert").filter({ hasText: "at capacity" }),
  ).toHaveText("Analysis service is at capacity — try again in a minute.");
  await expect(page.getByText("quota exhausted")).toBeHidden();

  // The filing row is still there — retrying the analyze recovers
  const analyze = page.getByRole("button", { name: "Analyze" });
  await expect(analyze).toBeEnabled();
  await analyze.click();
  await expect(page).toHaveURL(/\/analysis\/1$/);
});

test("mobile viewport has no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("combobox")).toBeVisible();

  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
