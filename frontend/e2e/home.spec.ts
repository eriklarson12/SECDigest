import { test, expect } from "@playwright/test";
import { ANALYSIS, mockApi, mockWatchlistApi } from "./mocks";

/** Homepage surfaces: the recent-analyses list and the YoY delta it renders
 * from the same payload it already had (roadmap Tier 7). */

test("recent analyses rows carry the YoY revenue delta", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const row = page.getByRole("link", { name: /Apple Inc\./ });
  await expect(row).toContainText("$1.00B");
  // ANALYSIS.revenue_yoy_change_pct is 5.5 — positive, so ▲ and no minus sign
  await expect(row).toContainText("▲ 5.5%");
});

test("the insight card keeps its delta after the extraction", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await expect(page.getByText("▲ 5.5% year over year")).toBeVisible();
  // net_income_yoy_change_pct is -1.2 — the glyph flips and the sign is dropped
  await expect(page.getByText("▼ 1.2% year over year")).toBeVisible();
});

/** The delta adds a fourth column to a row that had three at 375px, which is
 * the width the design rules call out. Guard it rather than eyeballing it. */
test("the recent-analyses row does not overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("link", { name: /Apple Inc\./ })).toBeVisible();
  // A fresh context has no recents, so the chip row is on screen here too
  await expect(
    page.getByRole("region", { name: "Suggested companies" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("the watchlist strip counts watched companies and newer filings", async ({
  page,
}) => {
  await mockWatchlistApi(page);
  await page.goto("/");

  const strip = page.getByRole("region", { name: "Watchlist" });
  await expect(strip.getByRole("link", { name: "Watching 2" })).toBeVisible();
  // MSFT filed 2026-06-15 with nothing analyzed; AAPL is up to date
  await expect(strip).toContainText("1 has filings newer than your analysis");
});

test("an empty watchlist renders no strip at all", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("region", { name: "Watchlist" })).toHaveCount(0);
});

/** The reason lib/watchlistStatus exists: two surfaces, two requests per
 * company, and a 30/min limit on /api/filings. Uncached, this walk costs four
 * filings calls; the cache makes it two. */
test("navigating to the watchlist reuses the strip's lookups", async ({
  page,
}) => {
  // page.on observes every request; a counting page.route would have to be
  // registered after the fulfilling one and fall back to it, which is fragile.
  const filingsCalls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/filings/")) filingsCalls.push(req.url());
  });
  await mockWatchlistApi(page);
  await page.goto("/");

  const strip = page.getByRole("region", { name: "Watchlist" });
  await expect(strip).toContainText("1 has filings newer than your analysis");
  expect(filingsCalls).toHaveLength(2);

  await strip.getByRole("link", { name: "Watching 2" }).click();
  await expect(page.getByText("Microsoft Corporation")).toBeVisible();
  await expect(page.getByText("New filing")).toBeVisible();

  expect(filingsCalls).toHaveLength(2);
});

test("starter chips seed the first visit and retire after one use", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  const chips = page.getByRole("region", { name: "Suggested companies" });
  await expect(chips.getByRole("button")).toHaveCount(6);

  await chips.getByRole("button", { name: /^AAPL/ }).click();
  await expect(page.getByText("Recent Filings for")).toBeVisible();

  // The chip recorded a recent search, which is the condition that hides it
  await page.goto("/");
  await expect(chips).toHaveCount(0);
  await page.getByRole("combobox").click();
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();
});

/** The chips are buttons on the same page as FilingSelector's "Analyze"
 * buttons and the filings filter's "10-K"/"10-Q" ones. An accessible name
 * overlapping either would break those suites silently, since Playwright
 * matches role names by substring. */
test("chip names do not collide with the page's other buttons", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "10-K" })).toHaveCount(0);
});

/** listAnalyses already returns the whole table's count and a created_at-desc
 * list; the caption is that data, not another request. The timestamp is
 * computed here because ANALYSIS.created_at is a fixed date that drifts past
 * every relative branch as the repo ages. */
test("the corpus caption reports the total and how fresh it is", async ({
  page,
}) => {
  await mockApi(page);
  // Registered after mockApi so it wins — later routes take precedence
  await page.route("**/api/analysis*", (route) =>
    route.fulfill({
      json: {
        analyses: [
          {
            ...ANALYSIS,
            created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          },
        ],
        total: 412,
      },
    }),
  );
  await page.goto("/");

  const recents = page.getByRole("region", {
    name: "Recently analyzed filings",
  });
  await expect(recents).toContainText(
    "412 filings analyzed · newest 3 hours ago",
  );
});

/** The method note is the page's floor: a fresh instance with nothing analyzed
 * has no recents, no watchlist and no chips-after-first-use, and would
 * otherwise end at the search box. */
test("the method note survives an empty corpus", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis*", (route) =>
    route.fulfill({ json: { analyses: [], total: 0 } }),
  );
  await page.goto("/");

  await expect(
    page.getByRole("region", { name: "Recently analyzed filings" }),
  ).toHaveCount(0);

  const how = page.getByRole("region", { name: "How it works" });
  await expect(how).toBeVisible();
  await expect(how.getByRole("listitem")).toHaveCount(4);
});

test("the homepage states where the data comes from", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await expect(
    page.getByText(
      "Data from SEC EDGAR. Extracted figures and summaries are model-generated and can be wrong — not investment advice.",
    ),
  ).toBeVisible();
});

/** The picked company used to live only in React state, and a `Link` to "/"
 * from "/" re-renders the same tree without clearing it — so the header's Home
 * link and the wordmark left the filings list on screen. `?ticker=` is what
 * makes those links a real navigation. */
test("the header's Home link returns to the homepage after a company is picked", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  await page
    .getByRole("region", { name: "Suggested companies" })
    .getByRole("button", { name: /^AAPL/ })
    .click();
  await expect(page.getByText("Recent Filings for")).toBeVisible();
  await expect(page).toHaveURL(/\?ticker=AAPL$/);

  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByText("Recent Filings for")).toBeHidden();
  await expect(
    page.getByRole("region", { name: "How it works" }),
  ).toBeVisible();

  // Back undoes the return, the same way it undoes the selection
  await page.goBack();
  await expect(page.getByText("Recent Filings for")).toBeVisible();

  await page.getByRole("link", { name: "SECDigest" }).click();
  await expect(page.getByText("Recent Filings for")).toBeHidden();
});

test("a shared ?ticker= link opens on that company's filings", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/?ticker=AAPL");

  await expect(page.getByText("Recent Filings for")).toBeVisible();
});
