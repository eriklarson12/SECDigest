import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS } from "./mocks";

/** 25 stored analyses — one page of 20 plus a short tail. The first 22 share the
 * fixture's SIC; the tail carries a second one, so a SIC filter narrows to a page
 * short enough that "Load more" must disappear if the filter reached the server. */
const OTHER_SIC = { sic: "7372", sic_description: "Prepackaged Software" };

const ALL_ROWS = Array.from({ length: 25 }, (_, i) => ({
  ...ANALYSIS,
  id: i + 1,
  accession_number: `00003201932600${String(i).padStart(4, "0")}`,
  ticker: `T${i + 1}`,
  company_name: `Test Company ${i + 1}`,
  ...(i >= 22 ? OTHER_SIC : {}),
  // A comma inside a risk factor exercises CSV quoting
  risk_factors: ["Regulatory, litigation and tax risks."],
}));

async function mockPagedList(page: Page) {
  await page.route("**/api/analysis?*", async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const ticker = url.searchParams.get("ticker");
    const sic = url.searchParams.get("sic");
    let rows = ALL_ROWS;
    if (ticker) rows = rows.filter((r) => r.ticker === ticker);
    if (sic) rows = rows.filter((r) => r.sic === sic);
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

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T20", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T21", exact: true }),
  ).toBeHidden();
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();

  // Appends the tail, then disappears (short page = end of data)
  await loadMore.click();
  await expect(
    page.getByRole("link", { name: "T25", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(loadMore).toBeHidden();
});

test("CSV export downloads all loaded rows with quoting intact", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();

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
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("T3");
  await filterInput.press("Enter");

  await expect(
    page.getByRole("link", { name: "T3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();

  await filterInput.fill("");
  await filterInput.press("Enter");

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("empty filter result shows Clear filter", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history");
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("ZZZZ");
  await filterInput.press("Enter");

  await expect(page.getByText("No analyses for ZZZZ")).toBeVisible();
  const clearButton = page.getByRole("button", { name: "Clear filter" });
  await expect(clearButton).toBeVisible();

  await clearButton.click();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
});

// --- Industry filter (roadmap 8.2) ---

test("?sic= filters the list, names the filter, and counts the matches", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=7372");

  await expect(
    page.getByRole("link", { name: "T23", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeHidden();

  // The label comes from the returned rows, not from the URL, which carries only the code
  await expect(page.getByTestId("active-sic-filter")).toContainText(
    "Filtered to SIC 7372 · Prepackaged Software",
  );
  await expect(page.getByTestId("filter-count")).toHaveText("3 analyses");
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();
});

test("Load more keeps the industry filter", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=3571");

  await expect(page.getByTestId("filter-count")).toHaveText("22 analyses");
  await page.getByRole("button", { name: "Load more" }).click();

  // Page two of the filtered set, not of the corpus: T23 belongs to the other SIC
  await expect(
    page.getByRole("link", { name: "T22", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "T23", exact: true }),
  ).toBeHidden();
});

test("clearing the industry filter drops the param and restores page one", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=7372");
  await expect(page.getByTestId("active-sic-filter")).toBeVisible();

  await page
    .getByTestId("active-sic-filter")
    .getByRole("button", { name: "Clear" })
    .click();

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("active-sic-filter")).toBeHidden();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("an unmatched industry code shows the empty state, not an error", async ({
  page,
}) => {
  await mockPagedList(page);
  await page.goto("/history?sic=9999");

  await expect(page.getByText("No analyses for SIC 9999")).toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("0 analyses");
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();

  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
});

test("a junk sic param degrades to the unfiltered page", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=not-a-code");

  await expect(
    page.getByRole("link", { name: "T1", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("active-sic-filter")).toBeHidden();
});

test("the ticker filter and the industry filter combine", async ({ page }) => {
  await mockPagedList(page);
  await page.goto("/history?sic=3571");
  await expect(page.getByTestId("filter-count")).toHaveText("22 analyses");

  const filterInput = page.getByLabel("Filter history by ticker");
  await filterInput.fill("T23");
  await filterInput.press("Enter");

  // T23 exists but sits in the other SIC, so the AND is empty
  await expect(
    page.getByText("No analyses for T23 · SIC 3571 · Electronic Computers"),
  ).toBeVisible();
});

test("the active filter line does not overflow a 375px viewport", async ({
  page,
}) => {
  await page.route("**/api/analysis?*", (route) =>
    route.fulfill({
      json: {
        analyses: [
          {
            ...ALL_ROWS[0],
            sic: "7372",
            // One of the longest descriptions EDGAR issues.
            sic_description: "Services-Computer Programming, Data Processing, Etc.",
          },
        ],
        total: 1,
      },
    }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/history?sic=7372");

  await expect(page.getByTestId("active-sic-filter")).toBeVisible();
  await expect(page.getByTestId("filter-count")).toHaveText("1 analysis");
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
