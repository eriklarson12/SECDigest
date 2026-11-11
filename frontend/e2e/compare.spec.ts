import { test, expect, type Page } from "@playwright/test";
import { ANALYSIS, FINANCIALS_MSFT, MSFT, mockCompareApi } from "./mocks";

// ANALYSIS is Apple's 10-Q. Each side gets an annual and a quarterly so the pair has a choice.
const AAPL_10K = {
  ...ANALYSIS,
  id: 2,
  accession_number: "000032019325000079",
  form_type: "10-K",
  filing_date: "2025-10-31",
};
const MSFT_10Q = {
  ...ANALYSIS,
  id: 3,
  accession_number: "000095017026000047",
  cik: MSFT.cik,
  ticker: MSFT.ticker,
  company_name: MSFT.name,
  form_type: "10-Q",
  filing_date: "2026-04-29",
};
const MSFT_10K = {
  ...MSFT_10Q,
  id: 4,
  accession_number: "000095017025000090",
  form_type: "10-K",
  filing_date: "2025-07-30",
};

/** Serves each ticker's stored analyses, in creation order rather than filing order. */
async function routeAnalyses(
  page: Page,
  byTicker: Record<string, unknown[]>,
): Promise<{ count: () => number }> {
  let calls = 0;
  await page.route("**/api/analysis?*", async (route) => {
    calls += 1;
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    const analyses = byTicker[ticker ?? ""] ?? [];
    await route.fulfill({ json: { analyses, total: analyses.length } });
  });
  return { count: () => calls };
}

test("compare flow: pick two tickers, URL reflects the pair", async ({
  page,
}) => {
  await mockCompareApi(page);
  await page.goto("/compare");

  const boxes = page.getByRole("combobox");
  await boxes.nth(0).fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page).toHaveURL(/\/compare\?a=AAPL$/);
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByText("Apple Inc.")).toBeVisible();

  await boxes.nth(1).fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();
  await expect(page).toHaveURL(/\/compare\?a=AAPL&b=MSFT$/);
  await expect(page.getByText("No analysis yet for MSFT")).toBeVisible();
});

test("shared compare URL reproduces the view", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare?a=AAPL&b=AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toHaveCount(2);
  await expect(page.getByText("Apple Inc.")).toHaveCount(2);
});

test("invalid URL params degrade to the empty pickers", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare?a=..%2Fetc&b=");

  // Both search boxes, both empty — the pickers are the empty state now, so
  // this asserts them directly rather than a sentence that repeated them.
  const boxes = page.getByRole("combobox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toHaveValue("");
  await expect(boxes.nth(1)).toHaveValue("");
});

test("trend overlay appears once both sides have a company", async ({
  page,
}) => {
  await mockCompareApi(page);
  await page.goto("/compare");

  const overlay = page.getByLabel(/Line chart comparing AAPL and MSFT/);
  const boxes = page.getByRole("combobox");

  await boxes.nth(0).fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(overlay).toHaveCount(0);

  await boxes.nth(1).fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();

  await expect(overlay).toBeVisible();
  for (const series of [
    "AAPL Revenue",
    "MSFT Revenue",
    "AAPL Net Income",
    "MSFT Net Income",
  ]) {
    await expect(overlay.getByText(series, { exact: true })).toBeVisible();
  }
});

test("trend overlay is absent when a company has too short a history", async ({
  page,
}) => {
  await mockCompareApi(page);
  await page.route("**/api/financials/789019", (route) =>
    route.fulfill({
      json: { ...FINANCIALS_MSFT, years: FINANCIALS_MSFT.years.slice(0, 1) },
    }),
  );
  await page.goto("/compare?a=AAPL&b=MSFT");

  await expect(page.getByText("No analysis yet for MSFT")).toBeVisible();
  await expect(page.getByLabel(/Line chart comparing/)).toHaveCount(0);
});

test("pairs annual with annual and switches both sides to quarterly", async ({
  page,
}) => {
  await mockCompareApi(page);
  const requests = await routeAnalyses(page, {
    AAPL: [AAPL_10K, ANALYSIS],
    MSFT: [MSFT_10Q, MSFT_10K],
  });
  await page.goto("/compare?a=AAPL&b=MSFT");

  await expect(page.getByText("Filed Oct 31, 2025")).toBeVisible();
  await expect(page.getByText("Filed Jul 30, 2025")).toBeVisible();
  await expect(page.getByText("Fiscal year", { exact: true })).toHaveCount(4);

  // The shared link fills both boxes, not just the columns.
  const boxes = page.getByRole("combobox");
  await expect(boxes.nth(0)).toHaveValue("AAPL — Apple Inc.");
  await expect(boxes.nth(1)).toHaveValue("MSFT — Microsoft Corporation");

  const period = page.getByRole("group", { name: "Period" });
  await expect(period.getByRole("button", { name: "Annual" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const before = requests.count();
  await period.getByRole("button", { name: "Quarterly" }).click();

  await expect(page).toHaveURL(/form=10-Q/);
  await expect(page.getByText("Filed May 2, 2026")).toBeVisible();
  await expect(page.getByText("Filed Apr 29, 2026")).toBeVisible();
  await expect(page.getByText("Quarter", { exact: true })).toHaveCount(4);
  // Rewriting the URL must not resolve the pair again.
  expect(requests.count()).toBe(before);
});

test("a shared quarterly link opens on the quarterly pair", async ({ page }) => {
  await mockCompareApi(page);
  await routeAnalyses(page, {
    AAPL: [AAPL_10K, ANALYSIS],
    MSFT: [MSFT_10Q, MSFT_10K],
  });
  await page.goto("/compare?a=AAPL&b=MSFT&form=10-Q");

  await expect(page.getByText("Filed May 2, 2026")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Quarterly" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("says in words when the two periods differ", async ({ page }) => {
  await mockCompareApi(page);
  await routeAnalyses(page, { AAPL: [AAPL_10K], MSFT: [MSFT_10Q] });
  await page.goto("/compare?a=AAPL&b=MSFT");

  await expect(
    page.getByText("AAPL's figures cover a fiscal year, MSFT's one quarter."),
  ).toBeVisible();
  await expect(page.getByText("Fiscal year", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Quarter", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("group", { name: "Period" })).toHaveCount(0);
});

test("at 375px both pickers sit above the first column", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockCompareApi(page);
  await routeAnalyses(page, { AAPL: [AAPL_10K], MSFT: [MSFT_10K] });
  await page.goto("/compare?a=AAPL&b=MSFT");

  const firstColumn = page.getByRole("heading", { name: "AAPL" });
  await expect(firstColumn).toBeVisible();
  const second = await page.getByRole("combobox").nth(1).boundingBox();
  const column = await firstColumn.boundingBox();
  expect(second && column && second.y + second.height).toBeLessThan(
    column!.y,
  );
});
