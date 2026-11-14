import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks";

/** Roadmap 16.12: every page was "SECDigest", so tabs and history entries could not be told
 * apart. The analysis title is rendered by the client once the analysis loads. */

const PAGES = [
  { path: "/", title: "SECDigest" },
  { path: "/compare", title: "Compare · SECDigest" },
  { path: "/watchlist", title: "Watchlist · SECDigest" },
  { path: "/benchmark", title: "Benchmark · SECDigest" },
  { path: "/history", title: "All analyses · SECDigest" },
  { path: "/company/aapl", title: "AAPL · SECDigest" },
  { path: "/analysis/1", title: "AAPL 10-Q · SECDigest" },
];

for (const { path, title } of PAGES) {
  test(`${path} is titled "${title}"`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);
    await expect(page).toHaveTitle(title);
  });
}

test("the analysis title does not follow the reader to the next page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");
  await expect(page).toHaveTitle("AAPL 10-Q · SECDigest");

  await page
    .getByRole("navigation", { name: "Site" })
    .getByRole("link", { name: "Compare" })
    .click();
  await expect(page).toHaveURL(/\/compare$/);
  await expect(page).toHaveTitle("Compare · SECDigest");
  expect(await page.locator("title").count()).toBe(1);

  await page.goBack();
  await expect(page).toHaveTitle("AAPL 10-Q · SECDigest");
});
