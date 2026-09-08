import { test, expect } from "@playwright/test";
import { COMPANY_PROFILE, FINANCIALS, mockApi } from "./mocks";

/** roadmap 4.2 — the company page aggregates chart, filings, and analyses
 * for one ticker behind /company/{ticker}. */

test("company page aggregates chart, filings, and analyses", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await expect(page.getByText("Financial Trend")).toBeVisible();
  await expect(page.getByText("Recent Filings")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
  await expect(page.getByText("Past Analyses")).toBeVisible();
  await expect(page.getByRole("link", { name: "AAPL" }).first()).toBeVisible();

  // Analyzing from this page runs the same flow as the homepage
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page).toHaveURL(/\/analysis\/1$/);
});

test("invalid ticker format shows the empty state", async ({ page }) => {
  await mockApi(page);
  await page.goto("/company/1AAPL");
  await expect(page.getByText("Invalid ticker")).toBeVisible();
});

test("unknown ticker shows the empty state", async ({ page }) => {
  // mockApi's search fixture only ever resolves to AAPL, so a well-formed
  // ticker it doesn't return exercises the "no exact match" branch.
  await mockApi(page);
  await page.goto("/company/ZZZZ");
  await expect(page.getByText("Unknown ticker")).toBeVisible();
});

/** roadmap 8.1 — the SEC industry classification, named as the SEC's own code
 * rather than presented as a neutral industry label. */

test("company page shows the SEC industry classification", async ({ page }) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await expect(page.getByTestId("industry-badge")).toHaveText(
    "SIC 3571 · Electronic Computers",
  );
});

test("the company page industry line links to the filtered history", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await page.getByTestId("industry-badge").getByRole("link").click();

  await expect(page).toHaveURL(/\/history\?sic=3571$/);
});

test("an unclassified filer renders no industry line", async ({ page }) => {
  await mockApi(page);
  // EDGAR leaves roughly a quarter of listed filers unclassified.
  await page.route("**/api/companies/*/profile", (route) =>
    route.fulfill({
      json: { cik: "0000320193", sic: null, sic_description: null, owner_org: null },
    }),
  );
  await page.goto("/company/AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByTestId("industry-badge")).toHaveCount(0);
});

test("the industry line does not overflow a 375px viewport", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/companies/*/profile", (route) =>
    route.fulfill({
      json: {
        cik: "0000320193",
        // One of the longest descriptions EDGAR issues.
        sic: "7372",
        sic_description: "Services-Computer Programming, Data Processing, Etc.",
        owner_org: "06 Technology",
      },
    }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/company/AAPL");

  await expect(page.getByTestId("industry-badge")).toBeVisible();
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(375);
});

test("the peers button carries the ticker to the benchmark", async ({ page }) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  await page.getByRole("link", { name: "Compare to peers" }).click();
  // A ticker, not a SIC: the endpoint behind it is keyed on a company, and it is the
  // subject that guarantees itself a row in a list its own industry feed can omit.
  await expect(page).toHaveURL(/\/benchmark\?peers=AAPL$/);
});

test("an unclassified filer gets a disabled peers button with a reason", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/companies/*/profile", (route) =>
    route.fulfill({
      json: { cik: "0000320193", sic: null, sic_description: null, owner_org: null },
    }),
  );
  await page.goto("/company/AAPL");

  const button = page.getByRole("button", { name: "Compare to peers" });
  await expect(button).toBeDisabled();
  // The reason is wired with aria-describedby, so it is not visual-only.
  await expect(
    page.getByText("EDGAR has not classified this filer"),
  ).toBeVisible();
});

test("the peers button waits for the classification rather than flipping state", async ({
  page,
}) => {
  await mockApi(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/companies/*/profile", async (route) => {
    await held;
    await route.fulfill({ json: COMPANY_PROFILE });
  });
  await page.goto("/company/AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  // Neither form of the control exists yet — one that enables itself under the
  // cursor is worse than one that arrives.
  await expect(page.getByText("Compare to peers")).toHaveCount(0);

  release();
  await expect(
    page.getByRole("link", { name: "Compare to peers" }),
  ).toBeVisible();
});

/** roadmap 9.3 — figures a company has re-reported at a different value, read out of the
 * XBRL payloads the metrics table already fetched. */

test("revisions are collapsed under the metrics table until opened", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");

  const disclosure = page.getByText(
    "Revisions to previously reported figures (2)",
  );
  await expect(disclosure).toBeVisible();
  // Collapsed: the row exists in the DOM but is not shown. (The chart's axis carries
  // "FY2023" too, so the assertion has to be on a string only this section renders.)
  await expect(page.getByText("$67.95B → $35.35B")).toBeHidden();

  await disclosure.click();
  const rows = page.locator("details", { hasText: "Revisions to" }).locator("li");
  await expect(rows).toHaveCount(2);
  // Newest fiscal year leads; the second row is another metric and the other direction.
  await expect(rows.first()).toContainText("FY2023");
  await expect(rows.first()).toContainText("Revenue");
  await expect(rows.first()).toContainText("$67.95B → $35.35B");
  await expect(rows.first()).toContainText("▼ -48.0%");
  await expect(rows.nth(1)).toContainText("FY2022");
  await expect(rows.nth(1)).toContainText("Net Income");
  await expect(rows.nth(1)).toContainText("▲ +22.5%");
});

test("the disclosure sits under the table it annotates", async ({ page }) => {
  // It may sit above other sections, unlike RecentEvents: these rows arrive in the same
  // response as the metrics table, so they displace nothing the table has not already.
  await mockApi(page);
  await page.goto("/company/AAPL");
  await expect(page.getByText("Annual metrics")).toBeVisible();

  const order = await page.evaluate(() => {
    const table = document.querySelector("table");
    const details = document.querySelector("details");
    if (!table || !details) return null;
    return table.compareDocumentPosition(details) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? "after"
      : "before";
  });
  expect(order).toBe("after");
});

test("the wording never accuses the company of an error", async ({ page }) => {
  await mockApi(page);
  await page.goto("/company/AAPL");
  await page
    .getByText("Revisions to previously reported figures (2)")
    .click();

  const section = page.locator("details", { hasText: "Revisions to" });
  await expect(section).toContainText("does not classify which");
  for (const word of ["restated", "error", "discrepancy", "correction"]) {
    await expect(section).not.toContainText(new RegExp(word, "i"));
  }
});

test("both filings are linked so the reader can check the claim", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/company/AAPL");
  await page
    .getByText("Revisions to previously reported figures (2)")
    .click();

  const first = page.getByRole("link", { name: "First report" }).first();
  const latest = page.getByRole("link", { name: "Latest report" }).first();
  // Unpadded CIK, dashless accession — lib/edgar.ts owns both quirks.
  await expect(first).toHaveAttribute(
    "href",
    "https://www.sec.gov/Archives/edgar/data/320193/000004054524000027/",
  );
  await expect(latest).toHaveAttribute(
    "href",
    "https://www.sec.gov/Archives/edgar/data/320193/000004054526000008/",
  );
});

test("a filer with no revisions renders no disclosure at all", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: { ...FINANCIALS, revisions: [] } }),
  );
  await page.goto("/company/AAPL");

  await expect(page.getByText("Annual metrics")).toBeVisible();
  await expect(page.getByText(/Revisions to previously reported/)).toHaveCount(
    0,
  );
});

test("an opened revision does not overflow a 375px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockApi(page);
  await page.goto("/company/AAPL");
  await page
    .getByText("Revisions to previously reported figures (2)")
    .click();
  await expect(page.getByText("$67.95B → $35.35B")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
