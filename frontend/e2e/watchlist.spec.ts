import { test, expect, type Page } from "@playwright/test";
import {
  COMPANY,
  MSFT,
  mockApi,
  mockImportApi,
  mockWatchlistApi,
} from "./mocks";

test("star from the dashboard adds the company to the watchlist", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await page.getByRole("button", { name: "Add AAPL to watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "Remove AAPL from watchlist" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.goto("/watchlist");
  await expect(page.getByText("AAPL")).toBeVisible();
  await expect(page.getByText("Apple Inc.")).toBeVisible();

  await page
    .getByRole("button", { name: "Remove AAPL from watchlist" })
    .click();
  await expect(page.getByText("AAPL")).toBeHidden();
});

test("new-filing badge appears only when EDGAR is ahead of the analysis", async ({
  page,
}) => {
  await mockWatchlistApi(page);
  await page.goto("/watchlist");

  const aaplCard = page
    .locator("div")
    .filter({ has: page.getByText("Apple Inc.") })
    .last();
  const msftCard = page
    .locator("div")
    .filter({ has: page.getByText("Microsoft Corporation") })
    .last();

  await expect(msftCard.getByText("New filing")).toBeVisible();
  await expect(
    msftCard.getByRole("link", { name: "Analyze now" }),
  ).toBeVisible();

  await expect(aaplCard.getByText("New filing")).toBeHidden();
  await expect(
    aaplCard.getByRole("link", { name: "View analysis" }),
  ).toHaveAttribute("href", "/analysis/1");
});

/** A rejected analyses lookup once returned `latestAnalysis: null`, which reads
 * exactly like "never analyzed" — so a company whose newest filing was already
 * analyzed got a "New filing" badge whenever that one request failed. */
test("a failed analysis lookup does not badge an up-to-date company", async ({
  page,
}) => {
  await mockWatchlistApi(page);
  // Later registration wins: AAPL's lookup fails, MSFT's still answers empty.
  await page.route("**/api/analysis?*", async (route) => {
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    if (ticker === COMPANY.ticker) {
      await route.fulfill({ status: 500, body: "boom" });
      return;
    }
    await route.fulfill({ json: { analyses: [], total: 0 } });
  });
  await page.goto("/watchlist");

  const aaplCard = page
    .locator("div")
    .filter({ has: page.getByText("Apple Inc.") })
    .last();

  // The filing itself still resolved, so the card is past its loading state
  await expect(aaplCard.getByText("May 2, 2026")).toBeVisible();
  await expect(aaplCard.getByText("New filing")).toBeHidden();

  // MSFT genuinely has nothing analyzed — that badge must survive
  await expect(page.getByText("New filing")).toHaveCount(1);
});

/** Import by link (roadmap 14.2). */

const KEY = "secdigest.watchlist";
const NVDA = { cik: "1045810", ticker: "NVDA", name: "NVIDIA Corp" };

/** Seeds once: an init script runs on every navigation, and an unguarded one
 * would undo the import on the reload the first test makes. */
async function seed(page: Page, items: { ticker: string }[]) {
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null)
        window.localStorage.setItem(key, value);
    },
    [KEY, JSON.stringify(items)] as const,
  );
}

function storedTickers(page: Page): Promise<string[]> {
  return page.evaluate(
    (key) =>
      (JSON.parse(window.localStorage.getItem(key) ?? "[]") as {
        ticker: string;
      }[]).map((c) => c.ticker),
    KEY,
  );
}

test("an import link asks before writing", async ({ page }) => {
  await mockImportApi(page, [COMPANY, MSFT]);
  await page.goto("/watchlist?import=AAPL,MSFT");

  await expect(
    page.getByText("Add 2 companies to your watchlist?"),
  ).toBeVisible();
  expect(await storedTickers(page)).toEqual([]);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Added 2 companies.")).toBeVisible();
  await expect(page).toHaveURL(/\/watchlist$/);
  await expect(page.getByRole("link", { name: "AAPL" })).toBeVisible();
  await expect(page.getByRole("link", { name: "MSFT" })).toBeVisible();
  expect(await storedTickers(page)).toEqual(["AAPL", "MSFT"]);

  await page.reload();
  await expect(page.getByRole("link", { name: "MSFT" })).toBeVisible();
  await expect(page.getByText(/to your watchlist\?/)).toBeHidden();
});

test("cancel leaves the watchlist alone", async ({ page }) => {
  await seed(page, [COMPANY]);
  await mockImportApi(page, [COMPANY, MSFT]);
  await page.goto("/watchlist?import=MSFT");

  await expect(
    page.getByText("Add 1 company to your watchlist?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/watchlist$/);
  await expect(page.getByText(/to your watchlist\?/)).toBeHidden();
  expect(await storedTickers(page)).toEqual(["AAPL"]);
});

test("an over-cap import says how many were skipped", async ({ page }) => {
  const filler = Array.from({ length: 19 }, (_, i) => ({
    cik: String(1000 + i),
    ticker: `T${i}`,
    name: `Filler ${i}`,
  }));
  await seed(page, filler);
  await mockImportApi(page, [COMPANY, MSFT, NVDA]);
  await page.goto("/watchlist?import=AAPL,MSFT,NVDA");

  await expect(
    page.getByText("Your watchlist has room for 1, so 2 will be skipped."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByText(
      "Added 1 company; 2 skipped because the watchlist holds 20.",
    ),
  ).toBeVisible();
  const stored = await storedTickers(page);
  expect(stored).toHaveLength(20);
  expect(stored[0]).toBe("AAPL");
});

test("unknown and already-watched tickers are reported", async ({ page }) => {
  await seed(page, [COMPANY]);
  await mockImportApi(page, [COMPANY]);
  await page.goto("/watchlist?import=AAPL,ZZZZ");

  await expect(
    page.getByText("AAPL is already on your watchlist."),
  ).toBeVisible();
  await expect(page.getByText("ZZZZ wasn't found.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page).toHaveURL(/\/watchlist$/);
  expect(await storedTickers(page)).toEqual(["AAPL"]);
});

test("a failed lookup is reported as unchecked, not unknown", async ({
  page,
}) => {
  await mockImportApi(page, [COMPANY]);
  // Later registration wins: MSFT's lookup fails outright.
  await page.route("**/api/companies/search*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "MSFT") return route.fulfill({ status: 500, body: "boom" });
    return route.fallback();
  });
  await page.goto("/watchlist?import=AAPL,MSFT");

  await expect(
    page.getByText("Add 1 company to your watchlist?"),
  ).toBeVisible();
  await expect(page.getByText("Couldn't check MSFT.")).toBeVisible();
  await expect(page.getByText(/wasn't found/)).toBeHidden();
});

test("a copied link imports into another profile", async ({
  page,
  browser,
}) => {
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"]);
  await seed(page, [COMPANY, MSFT]);
  await mockImportApi(page, [COMPANY, MSFT]);
  await page.goto("/watchlist");

  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(
    page.getByRole("button", { name: "Link copied" }),
  ).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const origin = new URL(page.url()).origin;
  expect(link).toBe(`${origin}/watchlist?import=AAPL,MSFT`);

  // A fresh context shares no storage with the first: the second device.
  const other = await browser.newContext({ serviceWorkers: "block" });
  const otherPage = await other.newPage();
  await mockImportApi(otherPage, [COMPANY, MSFT]);
  await otherPage.goto(link);
  await otherPage.getByRole("button", { name: "Add", exact: true }).click();
  await expect(otherPage.getByText("Added 2 companies.")).toBeVisible();

  expect(await storedTickers(otherPage)).toEqual(await storedTickers(page));
  await other.close();
});

/** Atom feed (roadmap 14.1). */

test("subscribe links the watchlist's tickers to the feed", async ({ page }) => {
  await mockWatchlistApi(page);
  await page.goto("/watchlist");

  await expect(page.getByRole("link", { name: "Subscribe" })).toHaveAttribute(
    "href",
    /\/api\/feeds\/watchlist\.atom\?tickers=AAPL,MSFT$/,
  );
});

test("an empty watchlist offers no feed", async ({ page }) => {
  await mockApi(page);
  await page.goto("/watchlist");

  await expect(page.getByText("Your watchlist is empty")).toBeVisible();
  await expect(page.getByRole("link", { name: "Subscribe" })).toHaveCount(0);
});
