import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks";

/** roadmap 4.7 — "/" reaches the search, Tab reaches a skip link. */

test('"/" focuses the search and opens it for typing', async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const search = page.getByRole("combobox");
  await expect(search).not.toBeFocused();

  // Retry: waiting for the input in the DOM does not mean React has hydrated and
  // attached the document listener, and `next dev` hydrates late enough to lose the race.
  await expect(async () => {
    await page.keyboard.press("/");
    await expect(search).toBeFocused({ timeout: 500 });
  }).toPass({ timeout: 15_000 });

  await page.keyboard.type("AAPL");
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();
  // The keypress focused the field; it must not also have typed a slash.
  await expect(search).toHaveValue("AAPL");
});

test('"/" typed inside the search box inserts a slash', async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const search = page.getByRole("combobox");
  await search.click();
  await page.keyboard.type("BRK/B");
  await expect(search).toHaveValue("BRK/B");
});

test('"/" with a modifier is left to the browser', async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await page.keyboard.press("Control+/");
  await expect(page.getByRole("combobox")).not.toBeFocused();
});

test('"/" on the compare page focuses the first of the two searches', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/compare");
  // Both must be mounted and hydrated before the key can reach a listener.
  await expect(page.getByRole("combobox")).toHaveCount(2);

  await expect(async () => {
    await page.keyboard.press("/");
    await expect(page.getByRole("combobox").nth(0)).toBeFocused({
      timeout: 500,
    });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("combobox").nth(1)).not.toBeFocused();
});

test("the skip link is the first thing Tab reaches and jumps past the nav", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(page.getByRole("combobox")).toBeVisible();

  // sr-only clips to a 1x1 box rather than display:none, so Playwright still
  // calls it "visible" — the size is what actually distinguishes the states.
  const clipped = await skip.boundingBox();
  expect(clipped?.width).toBeLessThan(5);
  await expect(skip).not.toBeFocused();

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  const revealed = await skip.boundingBox();
  expect(revealed?.width).toBeGreaterThan(50);

  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});
