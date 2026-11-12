import { test, expect, type Page } from "@playwright/test";
import {
  ANALYSIS_SEGMENTED,
  CHANGES_NEW,
  CHANGES_PRIOR,
  mockApi,
  mockChangesApi,
} from "./mocks";

/** Summary first, the jump row, and the "What changed" button (roadmap 16.8). */

const ROW = { name: "On this page" };

async function serveSegmented(page: Page) {
  await mockApi(page);
  await page.route("**/api/analysis/1", (route) =>
    route.fulfill({ json: ANALYSIS_SEGMENTED }),
  );
}

/** Clicks each link in order and checks its section scrolled into view. */
async function walkLinks(page: Page, expected: [string, string][]) {
  const row = page.getByRole("navigation", ROW);
  await expect(row.getByRole("link")).toHaveText(expected.map(([label]) => label));
  // Off-screen before its click, so the walk below cannot pass without scrolling.
  await expect(page.locator(`#${expected.at(-1)![1]}`)).not.toBeInViewport();
  for (const [label, id] of expected) {
    await row.getByRole("link", { name: label, exact: true }).click();
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
}

test("each analysis jump link scrolls its section into view", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await serveSegmented(page);
  await page.goto("/analysis/1");
  await walkLinks(page, [
    ["Summary", "summary"],
    ["Guidance", "guidance"],
    ["This filing", "this-filing"],
    ["Revenue breakdown", "revenue-breakdown"],
    ["Risk factors", "risk-factors"],
    ["Ask this filing", "ask"],
  ]);
});

test("each company jump link scrolls its section into view", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await mockApi(page);
  await page.goto("/company/AAPL");
  await expect(page.getByRole("heading", { name: "Past Analyses" })).toBeVisible();
  await walkLinks(page, [
    ["Financials", "financials"],
    ["Recent filings", "filings"],
    ["Past analyses", "past-analyses"],
  ]);
});

test("the executive summary comes directly after the headline figures", async ({ page }) => {
  await serveSegmented(page);
  await page.goto("/analysis/1");
  const order = ["Executive summary", "Management guidance", "This filing", "Key risk factors"];
  const tops: number[] = [];
  for (const name of order) {
    const heading = page.getByRole("heading", { name, exact: true });
    await expect(heading).toBeVisible();
    tops.push((await heading.boundingBox())!.y);
  }
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
});

test("the summary is visible without scrolling at 1024x768, with the button shown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  // Analysis 150's shape: a 10-K with a breakdown, a prior, and a summary of its length.
  const summary =
    "During fiscal year 2026, the company generated total net sales of $478.8 billion, a 15% " +
    "increase on the prior fiscal year, driven by strong growth in its largest product line and " +
    "in services. Net income rose 18% to $132.2 billion, supported by higher gross margins and " +
    "expanded operating profitability across all regions.";
  const current = { ...CHANGES_NEW, summary, segments: ANALYSIS_SEGMENTED.segments };
  await mockChangesApi(page);
  await page.route("**/api/analysis/10", (route) => route.fulfill({ json: current }));
  await page.goto(`/analysis/${CHANGES_NEW.id}`);

  await expect(page.getByRole("link", { name: /^What changed since/ })).toBeVisible();
  await expect(page.getByText(summary)).toBeInViewport({ ratio: 1 });
});

test("the What changed button names the prior and opens the changes page", async ({ page }) => {
  await mockChangesApi(page);
  await page.goto(`/analysis/${CHANGES_NEW.id}`);
  const button = page.getByRole("link", { name: "What changed since Nov 1, 2024" });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page).toHaveURL(`/analysis/${CHANGES_NEW.id}/changes`);
  await expect(page.getByRole("heading", { name: "AAPL: what changed" })).toBeVisible();
});

test("no What changed button without a prior same-form analysis", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");
  // The history has landed once the risk list's drift marker could have.
  await expect(page.getByRole("heading", { name: "Ask This Filing" })).toBeVisible();
  await expect(page.getByRole("link", { name: /What changed/ })).toHaveCount(0);
});

test("the button lands in a reserved line, and every jump link resolves before it", async ({
  page,
}) => {
  await mockChangesApi(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/analysis?*", async (route) => {
    await held;
    await route.fulfill({ json: { analyses: [CHANGES_NEW, CHANGES_PRIOR], total: 2 } });
  });
  await page.goto(`/analysis/${CHANGES_NEW.id}`);

  const row = page.getByRole("navigation", ROW);
  await expect(row).toBeVisible();
  for (const href of await row.getByRole("link").evaluateAll((links) =>
    links.map((a) => a.getAttribute("href")!),
  )) {
    await expect(page.locator(href)).toHaveCount(1);
  }
  const before = (await row.boundingBox())!.y;

  release();
  await expect(page.getByRole("link", { name: /^What changed since/ })).toBeVisible();
  expect((await row.boundingBox())!.y).toBe(before);
});
