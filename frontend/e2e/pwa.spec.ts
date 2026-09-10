import { test, expect } from "@playwright/test";
import { COMPANY, MSFT, mockWatchlistApi } from "./mocks";

// The rest of the suite runs with serviceWorkers: "block" (see
// playwright.config.ts). This is the one spec that needs a live worker.
test.use({ serviceWorkers: "allow" });

// ServiceWorkerRegistrar registers only in production, and `next dev` cannot
// stand in: with no network its HMR client never connects and hydration stalls,
// so the page renders its server markup and nothing else. CI already builds and
// starts a production server; locally, run `CI=1 npx playwright test pwa`.
const productionOnly = () =>
  test.skip(
    !process.env.CI,
    "needs a production build: the dev server's HMR client stalls hydration offline",
  );

/** Wait for the app's own registration to take control. The first load races
 *  activation, so the reload is also what puts the page's scripts through the
 *  worker and into the cache the offline load reads. */
async function warmTheWorker(page: import("@playwright/test").Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.controller !== null);
}

test("the manifest describes an installable app", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);

  const manifest = await response.json();
  expect(manifest.name).toBe("SECDigest");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");

  // 192 and 512 are Chrome's installability floor; the maskable one is what
  // keeps Android from cropping the monogram.
  const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  expect(
    manifest.icons.some(
      (icon: { purpose?: string }) => icon.purpose === "maskable",
    ),
  ).toBe(true);
});

test("the watchlist survives going offline", async ({ page, context }) => {
  productionOnly();
  await mockWatchlistApi(page);

  await page.goto("/watchlist");
  await expect(page.getByText(COMPANY.name)).toBeVisible();
  await warmTheWorker(page);

  await context.setOffline(true);
  await page.reload();

  // The shell comes from the worker. The cards come from localStorage, which is
  // where the watchlist has always lived -- no backend state, roadmap 2.1.
  await expect(page.getByRole("heading", { name: "Watchlist" })).toBeVisible();
  await expect(page.getByText(COMPANY.name)).toBeVisible();
  await expect(page.getByText(MSFT.name)).toBeVisible();

  await expect(
    page.getByRole("status").filter({ hasText: "Offline" }),
  ).toBeVisible();
});

test("a page that was never visited falls back to the offline page", async ({
  page,
  context,
}) => {
  productionOnly();
  await mockWatchlistApi(page);

  await page.goto("/watchlist");
  await warmTheWorker(page);
  await expect(page.getByText(COMPANY.name)).toBeVisible();

  await context.setOffline(true);
  await page.goto("/benchmark");

  await expect(page.getByText("You are offline")).toBeVisible();
});
