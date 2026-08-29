import { test, expect, type Page } from "@playwright/test";
import {
  BENCHMARK_FINANCIALS,
  BENCHMARK_FINANCIALS_MSFT,
  COMPANY,
  MSFT,
  mockBenchmarkApi,
} from "./mocks";

/** The peer table (roadmap 5.4). Every figure below is hand-checkable against
 * the fixtures: AAPL is 20.0% / 30.0% / 10.0% CAGR, MSFT is 10.0% / 25.0% with
 * no FY2022 and therefore no 3-yr CAGR at all. */

/** Data rows only — getByRole("row") includes the header. */
function bodyTickers(page: Page) {
  return page.locator("tbody tr td:first-child a");
}

test("computes margins and CAGR for each watched company", async ({ page }) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");

  const aapl = page.locator("tbody tr", { hasText: "Apple Inc." });
  await expect(aapl).toContainText("2025");
  await expect(aapl).toContainText("$1.33B");
  await expect(aapl).toContainText("20.0%");
  await expect(aapl).toContainText("30.0%");
  await expect(aapl).toContainText("▲ 10.0%");

  const msft = page.locator("tbody tr", { hasText: "Microsoft Corporation" });
  await expect(msft).toContainText("$2.00B");
  await expect(msft).toContainText("10.0%");
  await expect(msft).toContainText("25.0%");
});

/** A 3-yr CAGR needs the year exactly three back. MSFT's series starts at
 * FY2024, so the honest answer is a dash, not a 1-year rate under a 3-yr header. */
test("leaves the CAGR blank when the span is not in the data", async ({
  page,
}) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");

  const msft = page.locator("tbody tr", { hasText: "Microsoft Corporation" });
  await expect(msft).not.toContainText("▲");
  await expect(msft).not.toContainText("▼");

  // OCF and CAGR are the two headers nobody can read cold, and a blank cell is
  // its own puzzle. The caption answers all three; the design system rules out
  // doing it in a tooltip.
  await expect(
    page.getByText(
      "CAGR is compound annual revenue growth across three fiscal years",
    ),
  ).toBeVisible();
});

test("sorting a column reorders the rows and moves aria-sort", async ({
  page,
}) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");

  // Default is net margin descending: AAPL 20.0% above MSFT 10.0%
  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);
  const netMargin = page.getByRole("columnheader", { name: /Net margin/ });
  await expect(netMargin).toHaveAttribute("aria-sort", "descending");

  await netMargin.getByRole("button").click();
  await expect(bodyTickers(page)).toHaveText(["MSFT", "AAPL"]);
  await expect(netMargin).toHaveAttribute("aria-sort", "ascending");

  // Switching columns hands aria-sort over rather than leaving two set
  const revenue = page.getByRole("columnheader", { name: /Revenue/ });
  await revenue.getByRole("button").click();
  await expect(revenue).toHaveAttribute("aria-sort", "descending");
  await expect(netMargin).toHaveAttribute("aria-sort", "none");
  await expect(bodyTickers(page)).toHaveText(["MSFT", "AAPL"]);
});

/** A missing figure is not the smallest one — MSFT has no CAGR, so it sits last
 * whichever way the column is pointed. */
test("rows with no value for the sorted column sink in both directions", async ({
  page,
}) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");

  const cagr = page.getByRole("columnheader", { name: /CAGR/ });
  await cagr.getByRole("button").click();
  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);

  await cagr.getByRole("button").click();
  await expect(cagr).toHaveAttribute("aria-sort", "ascending");
  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);
});

test("sorting works from the keyboard alone", async ({ page }) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");
  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);

  const button = page
    .getByRole("columnheader", { name: /Net margin/ })
    .getByRole("button");
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(bodyTickers(page)).toHaveText(["MSFT", "AAPL"]);
});

test("one company's failure leaves the rest of the table standing", async ({
  page,
}) => {
  await mockBenchmarkApi(page);
  // Registered after mockBenchmarkApi, so this wins for AAPL only
  await page.route("**/api/financials/**", async (route) => {
    if (route.request().url().includes(COMPANY.cik)) {
      await route.fulfill({ status: 500, body: "boom" });
      return;
    }
    await route.fulfill({ json: BENCHMARK_FINANCIALS_MSFT });
  });
  await page.goto("/benchmark");

  const aapl = page.locator("tbody tr", { hasText: "Apple Inc." });
  await expect(aapl).toContainText("Couldn't load financials");

  const msft = page.locator("tbody tr", { hasText: "Microsoft Corporation" });
  await expect(msft).toContainText("10.0%");
});

test("a shared ?add= link resolves the ticker onto the table", async ({
  page,
}) => {
  await page.route("**/api/companies/search*", (route) =>
    route.fulfill({ json: [MSFT] }),
  );
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: BENCHMARK_FINANCIALS_MSFT }),
  );
  await page.goto("/benchmark?add=MSFT");

  await expect(bodyTickers(page)).toHaveText(["MSFT"]);
  await expect(
    page.locator("tbody tr", { hasText: "Microsoft Corporation" }),
  ).toContainText("10.0%");
});

test("adding a company from the search box writes it into the URL", async ({
  page,
}) => {
  await page.route("**/api/companies/search*", (route) =>
    route.fulfill({ json: [MSFT] }),
  );
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: BENCHMARK_FINANCIALS_MSFT }),
  );
  await page.goto("/benchmark");

  await page.getByRole("combobox").fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();

  await expect(page).toHaveURL(/\?add=MSFT$/);
  await expect(bodyTickers(page)).toHaveText(["MSFT"]);
});

test("an empty watchlist gets an empty state, not a bare table", async ({
  page,
}) => {
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: BENCHMARK_FINANCIALS }),
  );
  await page.goto("/benchmark");

  await expect(page.getByText("Nothing to compare yet")).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
});

/** The nav went from four links to five. Its own scrollWidth is the measurement
 * — a page-level check would pass on an overflowing nav inside a clipped body. */
test("the five-link nav and the table both fit 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");
  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);

  await expect(page.getByRole("link", { name: "Benchmark" })).toBeVisible();
  const navOverflow = await page.evaluate(() => {
    const nav = document.querySelector("nav");
    if (!nav) return true;
    return nav.scrollWidth > nav.clientWidth;
  });
  expect(navOverflow).toBe(false);

  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(pageOverflow).toBe(false);
});

/** The box used to keep "MSFT — Microsoft Corporation" after a pick, and the
 * next search could not be typed until that was deleted by hand. On a surface
 * whose whole job is adding companies one after another, that blocks the
 * second add outright. */
test("the search box empties after each add, so the next one can be typed", async ({
  page,
}) => {
  await page.route("**/api/companies/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    route.fulfill({
      json: q.toUpperCase().startsWith("MSFT") ? [MSFT] : [COMPANY],
    });
  });
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: BENCHMARK_FINANCIALS_MSFT }),
  );
  await page.goto("/benchmark");

  const box = page.getByRole("combobox");
  await box.fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();
  await expect(box).toHaveValue("");

  // The second add is the one that used to be impossible
  await box.fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(bodyTickers(page)).toHaveText(["MSFT", "AAPL"]);
});
