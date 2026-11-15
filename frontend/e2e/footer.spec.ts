import { test, expect } from "@playwright/test";
import { ANALYSIS, mockApi } from "./mocks";

/** roadmap 16.16 — the caveat, the eval page and the repo are on every page. */

const PATHS = ["/", "/analysis/1", "/company/AAPL", "/watchlist", "/history", "/evals"];

for (const path of PATHS) {
  test(`${path} ends in the site footer`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);

    const footer = page.getByRole("contentinfo");
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText(
      "Data from SEC EDGAR. Summaries are model-generated and can be wrong. Not investment advice.",
    );
    await expect(
      footer.getByRole("link", { name: "Eval history" }),
    ).toHaveAttribute("href", "/evals");
    await expect(footer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/[^/]+\/SECDigest$/,
    );
  });
}

for (const [width, height] of [
  [375, 812],
  [1280, 800],
]) {
  test(`the footer starts below the fold on a short page at ${width}px`, async ({
    page,
  }) => {
    // Late sections end `main` and push whatever follows. Below the fold that push is
    // not a layout shift; inside it, it measured up to 0.14 CLS.
    await page.setViewportSize({ width, height });
    await mockApi(page);
    await page.goto("/watchlist");
    await expect(page.getByText("Your watchlist is empty")).toBeVisible();

    const top = await page
      .getByRole("contentinfo")
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(top).toBeGreaterThanOrEqual(height);
  });
}

test("a late list above the footer shifts nothing", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockApi(page);
  await page.route("**/api/analysis?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      json: {
        analyses: Array.from({ length: 8 }, (_, i) => ({ ...ANALYSIS, id: i + 1 })),
        total: 8,
      },
    });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as unknown as { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) w.__cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/history");
  await expect(page.getByRole("row")).toHaveCount(9);

  const cls = await page.evaluate(
    () => (window as unknown as { __cls: number }).__cls,
  );
  expect(cls).toBeLessThan(0.01);
});

test("footer links are 44px targets and fit a 375px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockApi(page);
  await page.goto("/");

  const footer = page.getByRole("contentinfo");
  for (const name of ["Eval history", "GitHub"]) {
    const box = await footer.getByRole("link", { name }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // Enter, not a click: `next dev` parks its indicator over the bottom-left corner,
  // which is where this link is once the page is scrolled to its end.
  await footer.getByRole("link", { name: "Eval history" }).press("Enter");
  await expect(page).toHaveURL(/\/evals$/);
});
