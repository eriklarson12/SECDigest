import { test, expect } from "@playwright/test";
import history from "../src/data/eval-history.json";

/** roadmap 13.3: the page renders the committed history and calls no API, so
 * these assert against the same JSON the build imports. */

test("the eval history lists every committed run", async ({ page }) => {
  await page.goto("/evals");

  const tables = page.getByRole("table");
  const extraction = tables.filter({ hasText: "Extraction" });
  const qa = tables.filter({ hasText: "Q&A" });

  await expect(extraction.locator("tbody tr")).toHaveCount(history.extraction.length);
  await expect(qa.locator("tbody tr")).toHaveCount(history.qa.length);
  for (const run of history.qa) {
    await expect(qa).toContainText(String(run.questions));
  }
});

test("a metric with one run shows its figure instead of a one-point chart", async ({
  page,
}) => {
  test.skip(history.extraction.length !== 1, "extraction has more than one run");
  await page.goto("/evals");

  const extraction = page.getByRole("region", { name: "Extraction accuracy" });
  await expect(extraction).toContainText("One run so far");
  await expect(extraction.locator("svg.recharts-surface")).toHaveCount(0);
});

test("each Q&A metric is a labelled chart", async ({ page }) => {
  await page.goto("/evals");

  const qa = page.getByRole("region", { name: "Q&A" });
  for (const title of [
    "Grounded answers",
    "Unanswerable questions refused",
    "Retrieval hit rate at K",
    "Citation precision",
  ]) {
    await expect(qa.getByRole("figure", { name: new RegExp(`^${title}:`) })).toBeVisible();
  }
});

test("the method note links to the scoring source", async ({ page }) => {
  await page.goto("/evals");

  await expect(page.getByRole("link", { name: "Q&A scoring source" })).toHaveAttribute(
    "href",
    /\/backend\/evals\/qa_scoring\.py$/,
  );
  await expect(
    page.getByRole("link", { name: "Extraction scoring source" }),
  ).toHaveAttribute("href", /\/backend\/evals\/scoring\.py$/);
});

test("the page does not scroll sideways at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/evals");
  await expect(page.getByRole("region", { name: "Q&A" })).toBeVisible();

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});
