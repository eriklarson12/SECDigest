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

/** Roadmap 16.11. 79px is the nav's height when its links were 20px tall and wrapped to two
 * rows beside the wordmark: the 44px targets must not cost the page any more than that. */
for (const width of [375, 320]) {
  test(`nav links are 44px targets on one row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("combobox")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Site" });
    const boxes = await nav.evaluate((el) =>
      [...el.querySelectorAll("a")].slice(1).map((a) => {
        const r = a.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, height: r.height };
      }),
    );
    expect(boxes).toHaveLength(5);
    for (const box of boxes) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.top).toBe(boxes[0].top);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right - 0.5);
    }

    const size = await nav.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      overflow: el.scrollWidth > el.clientWidth,
    }));
    expect(size.height).toBeLessThanOrEqual(79);
    expect(size.overflow).toBe(false);
  });
}
