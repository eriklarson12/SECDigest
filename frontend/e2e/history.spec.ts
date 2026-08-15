import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS } from "./mocks";

/** 25 stored analyses — one page of 20 plus a short tail. */
const ALL_ROWS = Array.from({ length: 25 }, (_, i) => ({
  ...ANALYSIS,
  id: i + 1,
  accession_number: `00003201932600${String(i).padStart(4, "0")}`,
  ticker: `T${i + 1}`,
  company_name: `Test Company ${i + 1}`,
  // A comma inside a risk factor exercises CSV quoting
  risk_factors: ["Regulatory, litigation and tax risks."],
}));

async function mockPagedList(page: Page) {
  await page.route("**/api/analysis?*", async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const ticker = url.searchParams.get("ticker");
    const rows = ticker ? ALL_ROWS.filter((r) => r.ticker === ticker) : ALL_ROWS;
    await route.fulfill({
      json: {
        analyses: rows.slice(offset, offset + limit),
        total: rows.length,
      },
    });
  });
}

test("history paginates with Load more", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");

  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "T20", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "T21", exact: true })).toBeHidden();
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();

  // Appends the tail, then disappears (short page = end of data)
  await loadMore.click();
  await expect(page.getByRole("link", { name: "T25", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();
  await expect(loadMore).toBeHidden();
});

test("CSV export downloads all loaded rows with quoting intact", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  const content = fs.readFileSync(await download.path(), "utf-8");

  expect(content.startsWith("ticker,company_name,form_type,")).toBe(true);
  expect(content).toContain('"Regulatory, litigation and tax risks."');
  // All 20 loaded rows exported (header + 20 rows, trailing newline)
  expect(content.trim().split("\r\n")).toHaveLength(21);
});

test("filters history by ticker", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("T3");
  await filterInput.press("Enter");

  await expect(page.getByRole("link", { name: "T3", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();

  await filterInput.fill("");
  await filterInput.press("Enter");

  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("empty filter result shows Clear filter", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("ZZZZ");
  await filterInput.press("Enter");

  await expect(page.getByText("No analyses for ZZZZ")).toBeVisible();
  const clearButton = page.getByRole("button", { name: "Clear filter" });
  await expect(clearButton).toBeVisible();

  await clearButton.click();
  await expect(page.getByRole("link", { name: "T1", exact: true })).toBeVisible();
});
