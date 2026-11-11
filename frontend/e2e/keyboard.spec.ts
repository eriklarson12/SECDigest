import { test, expect } from "@playwright/test";
import { COMPANY, MSFT, mockApi } from "./mocks";

/** roadmap 4.7 — "/" reaches the search, Tab reaches a skip link. 16.3 — Enter takes the top row. */

test('"/" focuses the search and opens it for typing', async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const search = page.getByRole("combobox");
  await expect(search).not.toBeFocused();

  // Retry: waiting for the input in the DOM does not mean React has hydrated and
  // attached the document listener, and `next dev` hydrates late enough to lose the race.
  await expect(async () => {
    await page.keyboard.press("/");
    await expect(search).toBeFocused({ timeout: 500 });
  }).toPass({ timeout: 15_000 });

  await page.keyboard.type("AAPL");
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();
  // The keypress focused the field; it must not also have typed a slash.
  await expect(search).toHaveValue("AAPL");
});

test('"/" typed inside the search box inserts a slash', async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const search = page.getByRole("combobox");
  await search.click();
  await page.keyboard.type("BRK/B");
  await expect(search).toHaveValue("BRK/B");
});

test('"/" with a modifier is left to the browser', async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await page.keyboard.press("Control+/");
  await expect(page.getByRole("combobox")).not.toBeFocused();
});

test('"/" on the compare page focuses the first of the two searches', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/compare");
  // Both must be mounted and hydrated before the key can reach a listener.
  await expect(page.getByRole("combobox")).toHaveCount(2);

  await expect(async () => {
    await page.keyboard.press("/");
    await expect(page.getByRole("combobox").nth(0)).toBeFocused({
      timeout: 500,
    });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("combobox").nth(1)).not.toBeFocused();
});

test("the skip link is the first thing Tab reaches and jumps past the nav", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(page.getByRole("combobox")).toBeVisible();

  // sr-only clips to a 1x1 box rather than display:none, so Playwright still
  // calls it "visible" — the size is what actually distinguishes the states.
  const clipped = await skip.boundingBox();
  expect(clipped?.width).toBeLessThan(5);
  await expect(skip).not.toBeFocused();

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  const revealed = await skip.boundingBox();
  expect(revealed?.width).toBeGreaterThan(50);

  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("Tab reaches both company links before the first filing", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?ticker=AAPL");
  await expect(page.getByRole("button", { name: /^Analyze/ })).toBeVisible();

  await page.getByRole("combobox").focus();
  const reached: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
    });
    reached.push(name);
    if (name.startsWith("Analyze")) break;
  }

  const ticker = reached.indexOf("AAPL");
  const company = reached.indexOf("Company page →");
  const filing = reached.findIndex((n) => n.startsWith("Analyze"));
  expect(ticker).toBeGreaterThanOrEqual(0);
  expect(company).toBeGreaterThan(ticker);
  expect(filing).toBeGreaterThan(company);
});

test("Enter with nothing arrowed to picks the top search result", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  const search = page.getByRole("combobox");
  await search.click();
  await page.keyboard.type("aapl");
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();
  // Row one is not highlighted: a screen reader would announce a pick the reader did not make.
  await expect(search).not.toHaveAttribute("aria-activedescendant");

  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: /Recent Filings for AAPL/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\?ticker=AAPL$/);
});

test("Enter before the response waits for it instead of picking the stale row", async ({
  page,
}) => {
  await mockApi(page);
  // "a" answers at once with AAPL; "ab" answers late with MSFT, so while it is
  // pending the open list still shows AAPL for a value no longer in the box.
  await page.route("**/api/companies/search*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "ab") await new Promise((r) => setTimeout(r, 1000));
    await route.fulfill({ json: q === "ab" ? [MSFT] : [COMPANY] });
  });
  const filingCiks: string[] = [];
  page.on("request", (req) => {
    const match = req.url().match(/\/api\/filings\/(\d+)/);
    if (match) filingCiks.push(match[1]);
  });
  await page.goto("/");

  const search = page.getByRole("combobox");
  await search.click();
  await page.keyboard.type("a");
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();

  await page.keyboard.type("b");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();

  await expect(
    page.getByRole("heading", { name: /Recent Filings for MSFT/ }),
  ).toBeVisible();
  expect(filingCiks).toContain(MSFT.cik);
  expect(filingCiks).not.toContain(COMPANY.cik);
});
