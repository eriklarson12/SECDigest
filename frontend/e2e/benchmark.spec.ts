import { test, expect, type Page } from "@playwright/test";
import {
  BENCHMARK_FINANCIALS,
  BENCHMARK_FINANCIALS_MSFT,
  COMPANY,
  MSFT,
  mockBenchmarkApi,
  mockPeersApi,
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

/** roadmap 9.4 — the revenue rank rides in on the same /api/financials response each row
 * already fetches, so the column costs no request against a 30/minute limit. */

test("each row carries its revenue rank among all filers", async ({ page }) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");

  await expect(
    page.locator("tbody tr", { hasText: "Apple Inc." }),
  ).toContainText("95.8th");
  await expect(
    page.locator("tbody tr", { hasText: "Microsoft Corporation" }),
  ).toContainText("70.4th");
  // The caption has to say what the population is, or "95.8th" reads as a rank among
  // all public companies rather than among filers that tagged revenue for the period.
  const caption = page.getByText("among every SEC filer that tagged revenue");
  await expect(caption).toBeVisible();
  // Measured on the live data: Microsoft's latest table row is FY2026 while its rank comes
  // from the CY2025 frame, on a different revenue figure. Reading straight across the row
  // without this sentence gets the wrong number ranked.
  await expect(caption).toContainText("may not be the year the FY column names");
});

test("sorting on the revenue rank reorders the rows", async ({ page }) => {
  await mockBenchmarkApi(page);
  await page.goto("/benchmark");
  await expect(bodyTickers(page)).toHaveCount(2);

  await page.getByRole("button", { name: "Revenue rank" }).click();
  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);
  await page.getByRole("button", { name: "Revenue rank" }).click();
  await expect(bodyTickers(page)).toHaveText(["MSFT", "AAPL"]);
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
  // Anchored: "Revenue rank" is a column too, and a loose /Revenue/ matches both.
  const revenue = page.getByRole("columnheader", { name: /^Revenue\s*[\u25b2\u25bc]?$/ });
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

/** Industry seeding (roadmap 8.4). ?peers= carries a ticker because that is what a
 * person can read; the endpoint behind it is keyed on the CIK that ticker resolves to. */

test("?peers= seeds the table from the company's industry, subject first", async ({
  page,
}) => {
  await mockPeersApi(page);
  await page.goto("/benchmark?peers=AAPL");

  await expect(bodyTickers(page).first()).toHaveText("AAPL");
  await expect(page.getByTestId("peer-caption")).toContainText(
    "SIC 7372 · Services-Computer Programming, Data Processing, Etc.",
  );
  // The classification is EDGAR's, not the app's, and the caption has to say so.
  await expect(page.getByTestId("peer-caption")).toContainText(
    "the filer's own EDGAR classification",
  );
});

test("an industry seed replaces the watchlist rather than joining it", async ({
  page,
}) => {
  await mockPeersApi(page);
  await page.goto("/benchmark?peers=AAPL");
  await expect(page.getByTestId("peer-caption")).toBeVisible();

  // The fixture stars AAPL and MSFT. Both are peers here too, so the tell is the
  // count: a merge would exceed the ten the peer list alone fills.
  await expect(bodyTickers(page)).toHaveCount(10);
  await expect(
    page.getByText("Showing the first 10 companies"),
  ).toBeVisible();
});

test("removing a row drops it and rewrites the URL to the remaining set", async ({
  page,
}) => {
  await mockPeersApi(page);
  await page.goto("/benchmark?peers=AAPL");
  await expect(bodyTickers(page)).toHaveCount(10);

  await page
    .getByRole("button", { name: "Remove MSFT from the comparison" })
    .click();

  await expect(bodyTickers(page)).toHaveCount(9);
  await expect(page.locator("tbody")).not.toContainText("Microsoft Corporation");
  // The edited set is the user's, so the link reopens exactly it rather than
  // re-deriving a list from EDGAR that may have moved.
  await expect(page).toHaveURL(/\/benchmark\?add=AAPL,PEER0,/);
  await expect(page).not.toHaveURL(/peers=/);
});

test("removing every row lands on the empty state at a bare /benchmark", async ({
  page,
}) => {
  await mockPeersApi(page);
  await page.goto("/benchmark?peers=AAPL");
  await expect(bodyTickers(page)).toHaveCount(10);

  for (let i = 0; i < 10; i++) {
    await page.locator('tbody button[aria-label^="Remove"]').first().click();
  }

  await expect(page.getByText("Nothing to compare yet")).toBeVisible();
  await expect(page).toHaveURL(/\/benchmark$/);
});

test("an unresolvable peer seed falls back to the watchlist", async ({
  page,
}) => {
  await mockPeersApi(page);
  await page.goto("/benchmark?peers=NOPE");

  // Two starred companies, no caption, no error — a dead seed is not a failure state.
  await expect(bodyTickers(page)).toHaveCount(2);
  await expect(page.getByTestId("peer-caption")).toBeHidden();
});

test("a failing peers lookup falls back to the watchlist", async ({ page }) => {
  await mockPeersApi(page);
  await page.route("**/api/companies/*/peers", (route) =>
    route.fulfill({ status: 502, json: { detail: "EDGAR is down" } }),
  );
  await page.goto("/benchmark?peers=AAPL");

  await expect(bodyTickers(page)).toHaveCount(2);
  await expect(page.getByTestId("peer-caption")).toBeHidden();
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
});

test("the peer caption does not overflow a 375px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockPeersApi(page);
  await page.goto("/benchmark?peers=AAPL");
  await expect(page.getByTestId("peer-caption")).toBeVisible();

  // The longest SIC descriptions run past 50 characters, which is why this is a
  // wrapping line and not a chip (docs/design-system.md).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});


/** Explicit-set seeding (roadmap 9.1). `?only=` exists because `?add=` is filtered against a
 * watchlist seed that has already taken all ten rows — the two tests below are the hazard and
 * the fix, side by side. */

/** Ten starred companies: the cap, so nothing can be layered on top. */
async function seedFullWatchlist(page: Page) {
  const watched = Array.from({ length: 10 }, (_, i) => ({
    ticker: `W${i}`,
    cik: `90000${i}`,
    name: `Watched ${i} Inc`,
  }));
  await page.addInitScript((items) => {
    window.localStorage.setItem("secdigest.watchlist", JSON.stringify(items));
  }, watched);
  await page.route("**/api/companies/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const match = [COMPANY, MSFT].find((c) => c.ticker === q.toUpperCase());
    return route.fulfill({ json: match ? [match] : [] });
  });
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: BENCHMARK_FINANCIALS }),
  );
}

test("?add= cannot get past a full watchlist — the reason ?only= exists", async ({
  page,
}) => {
  await seedFullWatchlist(page);
  await page.goto("/benchmark?add=AAPL");

  await expect(bodyTickers(page)).toHaveCount(10);
  await expect(bodyTickers(page)).not.toContainText(["AAPL"]);
});

test("?only= shows exactly the set it names, whatever is starred", async ({
  page,
}) => {
  await seedFullWatchlist(page);
  await page.goto("/benchmark?only=AAPL,MSFT");

  await expect(bodyTickers(page)).toHaveText(["AAPL", "MSFT"]);
});

test("an ?only= set stays editable and the removal is shareable", async ({
  page,
}) => {
  await seedFullWatchlist(page);
  await page.goto("/benchmark?only=AAPL,MSFT");
  await expect(bodyTickers(page)).toHaveCount(2);

  await page.getByRole("button", { name: /Remove MSFT/i }).click();

  await expect(bodyTickers(page)).toHaveText(["AAPL"]);
  // Once edited the set is the user's, so it is written back explicitly and stops
  // being an ?only= seed — the same rule ?peers= follows.
  await expect(page).toHaveURL(/add=AAPL/);
  await expect(page).not.toHaveURL(/only=/);
});

test("an ?only= set nobody can resolve falls back to the watchlist", async ({
  page,
}) => {
  // A dead seed is not a failure state, exactly as a dead ?peers= seed is not.
  await seedFullWatchlist(page);
  await page.goto("/benchmark?only=NOSUCH");

  await expect(bodyTickers(page)).toHaveCount(10);
});
