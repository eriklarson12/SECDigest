import { test, expect } from "@playwright/test";
import {
  INDEX_COMPLETE,
  INDEX_IN_PROGRESS,
  mockApi,
  SIMILAR,
  SIMILAR_EMPTY,
  SIMILAR_UNAVAILABLE,
} from "./mocks";

/** "Similar filing language" — language peers on the analysis dashboard (roadmap 9.1). */

const HEADING = { name: "Similar Filing Language" };
const CARD = { name: "Similar filing language" };

test.describe("ready state", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/analysis/1");
  });

  test("ranks the peers in the order the backend returned", async ({ page }) => {
    const rows = page.getByRole("listitem").filter({ hasText: /AVGO|AMZN|DELL/ });
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("AVGO");
    await expect(rows.nth(1)).toContainText("AMZN");
    await expect(rows.nth(2)).toContainText("DELL");
  });

  test("shows each peer's own SEC industry", async ({ page }) => {
    await expect(page.getByText("SIC 3674 · Semiconductors & Related Devices")).toBeVisible();
    await expect(page.getByText("SIC 5961 · Retail-Catalog & Mail-Order Houses")).toBeVisible();
  });

  test("names the pool as the corpus analyzed here, with its size", async ({ page }) => {
    // The honest-framing rule: the pool is this site's corpus, not EDGAR, and the copy
    // must say so rather than implying a market-wide ranking.
    await expect(
      page.getByText("Nearest of 56 other companies analyzed here"),
    ).toBeVisible();
  });

  test("never renders a similarity percentage", async ({ page }) => {
    // Cosine across the corpus spans roughly 0.80 to 0.99, so a percentage would read as a
    // strong match when it is average. The ordering is the signal.
    const card = page.getByRole("region", CARD);
    await expect(card).toBeVisible();
    await expect(card).not.toContainText("%");
    await expect(card).not.toContainText("0.94");
  });

  test("a row opens that filing's analysis", async ({ page }) => {
    await page.getByRole("link", { name: /AVGO/ }).click();
    await expect(page).toHaveURL(/\/analysis\/2$/);
  });

  test("Benchmark these seeds the subject plus its peers", async ({ page }) => {
    const link = page.getByRole("link", { name: "Benchmark these" });
    // ?only=, not ?add=: the benchmark page seeds the watchlist first and caps at ten rows,
    // so ?add= would silently drop every peer for a user with a full watchlist.
    await expect(link).toHaveAttribute(
      "href",
      "/benchmark?only=AAPL,AVGO,AMZN,DELL",
    );
  });

  test("sits below the Ask card, so a late arrival displaces nothing", async ({
    page,
  }) => {
    // Pins the CLS rule in frontend/CLAUDE.md: this section cannot render on the body's
    // first commit, so nothing may sit under it. Wait for it first — the card arrives after
    // hydration, and reading the order before it lands measures nothing.
    await expect(page.getByRole("region", CARD)).toBeVisible();
    const headings = await page
      .getByRole("heading", { level: 3 })
      .allTextContents();
    const ask = headings.findIndex((h) => h.includes("Ask This Filing"));
    const similar = headings.findIndex((h) => h.includes("Similar Filing Language"));
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(similar).toBeGreaterThan(ask);
  });
});

test("a thin corpus renders an explanation, not a one-row ranking", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/similar*", (route) =>
    route.fulfill({ json: SIMILAR_EMPTY }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByRole("heading", HEADING)).toBeVisible();
  await expect(
    page.getByText(/Not enough filings have been analyzed here yet/),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Benchmark these" })).toHaveCount(0);
});

test("an unindexed filing says it cannot be placed", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/similar*", (route) =>
    route.fulfill({ json: SIMILAR_UNAVAILABLE }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByText(/hasn't been indexed yet/)).toBeVisible();
});

test("an unindexed filing fills in when indexing finishes, without a reload", async ({
  page,
}) => {
  await mockApi(page);
  // Flipped by the test rather than counted by request number, for the reason the retry
  // test below gives: dev's double effect and CI's production build issue different counts.
  let indexed = false;
  await page.route("**/api/analysis/*/index-status", (route) =>
    route.fulfill({ json: indexed ? INDEX_COMPLETE : INDEX_IN_PROGRESS }),
  );
  await page.route("**/api/analysis/*/similar*", (route) =>
    route.fulfill({ json: indexed ? SIMILAR : SIMILAR_UNAVAILABLE }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByText(/hasn't been indexed yet/)).toBeVisible();

  indexed = true;
  // Polling is on a 5s timer, so allow more than one interval.
  await expect(page.getByRole("link", { name: /AVGO/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/hasn't been indexed yet/)).toHaveCount(0);
});

test("a failed lookup offers a retry that succeeds", async ({ page }) => {
  await mockApi(page);
  // Toggled by the test rather than counted: React's dev-mode double effect makes the first
  // request a cancelled one, so "fail call #1" means different things under `next dev` and the
  // production build CI runs. A flag behaves the same in both.
  let failing = true;
  await page.route("**/api/analysis/*/similar*", (route) =>
    failing
      ? route.fulfill({ status: 500, json: { detail: "boom" } })
      : route.fulfill({ json: SIMILAR_EMPTY }),
  );
  await page.goto("/analysis/1");

  const card = page.getByRole("region", CARD);
  await expect(card.getByRole("alert")).toBeVisible();

  failing = false;
  await card.getByRole("button", { name: "Retry" }).click();

  await expect(
    page.getByText(/Not enough filings have been analyzed here yet/),
  ).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("no horizontal scroll at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockApi(page);
  await page.goto("/analysis/1");
  await expect(page.getByRole("heading", HEADING)).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
