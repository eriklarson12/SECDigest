import { test, expect } from "@playwright/test";
import { COMPANY, FILINGS, mockApi } from "./mocks";

/** "Recent Events" — 8-K item codes as a company timeline (roadmap 9.2). */

const SECTION = { name: "Recent events" };

test.describe("a company that files 8-Ks", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto(`/company/${COMPANY.ticker}`);
  });

  test("names what each filing reported", async ({ page }) => {
    const section = page.getByRole("region", SECTION);
    await expect(section).toContainText("Results of Operations · Exhibits");
  });

  test("renders an unmapped code as its number rather than dropping it", async ({
    page,
  }) => {
    // EDGAR adds items without notice. A silently missing one reads as a filing that
    // said nothing, which is worse than an unfamiliar label.
    await expect(page.getByRole("region", SECTION)).toContainText("Item 7.02");
  });

  test("shows amendments, newest first", async ({ page }) => {
    // AAPL's most recent real event is an 8-K/A, so a strip built on `8-K` alone would
    // read a week stale. The badge says which it is.
    const rows = page.getByRole("region", SECTION).getByRole("listitem");
    await expect(rows.first()).toContainText("8-K/A");
    await expect(rows.first()).toContainText(
      "Departure or Election of Directors or Officers",
    );
  });

  test("keeps the 8-Ks out of the filing list", async ({ page }) => {
    // The events are a second reading of the same response, not extra rows to analyze.
    await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(1);
  });

  test("sits below Past Analyses, so a filer with none displaces nothing", async ({
    page,
  }) => {
    // Pins the CLS rule in frontend/CLAUDE.md: this section renders nothing at all for a
    // company with no 8-Ks, so nothing may sit under it.
    await expect(page.getByRole("region", SECTION)).toBeVisible();
    const headings = await page
      .getByRole("heading", { level: 2 })
      .allTextContents();
    const past = headings.findIndex((h) => h.includes("Past Analyses"));
    const events = headings.findIndex((h) => h.includes("Recent Events"));
    expect(past).toBeGreaterThanOrEqual(0);
    expect(events).toBeGreaterThan(past);
  });
});

test("the events cost no request of their own", async ({ page }) => {
  // The acceptance criterion as a test. The submissions document behind this call runs to
  // 4.5 MB for a filer like JPM, so a second read of it is not a rounding error.
  const requests: string[] = [];
  await mockApi(page);
  // After mockApi, not before: later registrations win, so a counter registered first
  // would never run. `fallback` hands the request back down to mockApi's handler.
  await page.route("**/api/filings/**", async (route) => {
    requests.push(route.request().url());
    await route.fallback();
  });
  await page.goto(`/company/${COMPANY.ticker}`);

  await expect(page.getByRole("region", { name: "Recent events" })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get("form_type")).toBe(
    "10-K,10-Q,8-K,8-K/A",
  );
});

test("the events survive the form-type filter", async ({ page }) => {
  // The control filters the filing list, not the timeline. Clicking 10-Q must not empty
  // a section it does not govern.
  await mockApi(page);
  await page.goto(`/company/${COMPANY.ticker}`);
  await expect(page.getByRole("region", { name: "Recent events" })).toBeVisible();

  await page.getByRole("button", { name: "10-Q", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Recent events" }),
  ).toContainText("Results of Operations");
});

test("a filer with no 8-Ks renders no section at all", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/filings/**", (route) =>
    route.fulfill({ json: FILINGS }),
  );
  await page.goto(`/company/${COMPANY.ticker}`);

  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent events" })).toHaveCount(0);
});

test("an eight-item filing does not scroll sideways at 375px", async ({ page }) => {
  // The chip decision as a test: a `whitespace-nowrap` pill per item would overflow here,
  // which is why the labels are one wrapping line (docs/design-system.md).
  await page.setViewportSize({ width: 375, height: 800 });
  await mockApi(page);
  await page.goto(`/company/${COMPANY.ticker}`);
  await expect(page.getByRole("region", { name: "Recent events" })).toContainText(
    "Item 7.02",
  );

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
