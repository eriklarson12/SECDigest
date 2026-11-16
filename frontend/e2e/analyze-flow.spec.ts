import { test, expect } from "@playwright/test";
import { ANALYSIS, COMPANY, mockApi, startStageServer } from "./mocks";

/** The main journey — search → pick a filing → analyze → dashboard — with the
 * backend mocked at the network layer, so this exercises the frontend alone. */

test("search → filing → analyze → dashboard", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await page.getByRole("combobox").fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();

  await expect(page.getByText("Recent Filings for")).toBeVisible();
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page).toHaveURL(/\/analysis\/1$/);
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  // ANALYSIS.filing_date is "2026-05-02" and the browser zone is pinned west of
  // UTC, so this reads May 1 if a bare date is ever parsed as UTC midnight again.
  await expect(page.getByText("Filed May 2, 2026")).toBeVisible();
  // "$1.00B" appears in the insight card and the annual metrics table
  await expect(page.getByText("$1.00B").first()).toBeVisible();
  await expect(
    page.getByText("Supply chain concentration risk."),
  ).toBeVisible();
  await expect(page.getByText("Financial Trend")).toBeVisible();
  // Metrics table renders diluted EPS from the XBRL mock (roadmap 2.3)
  await expect(page.getByRole("cell", { name: "$6.42" })).toBeVisible();
  await expect(
    page.getByText("Revenue grew 5.5% year over year."),
  ).toBeVisible();
  // Primary-source link (roadmap 1.4)
  await expect(
    page.getByRole("link", { name: "View filing on SEC.gov" }),
  ).toHaveAttribute(
    "href",
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000041/",
  );
  // The company page is named beside the source, not only behind the ticker (roadmap 16.2).
  await expect(page.getByRole("link", { name: "Company page" })).toHaveAttribute(
    "href",
    "/company/AAPL",
  );
});

test("keyboard-only search selection", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  const input = page.getByRole("combobox");
  await input.fill("AAPL");
  await expect(page.getByRole("option", { name: /AAPL/ })).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");

  await expect(page.getByText("Recent Filings for")).toBeVisible();
});

test("annual/quarterly chart toggle switches series", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const annual = page.getByRole("button", { name: "annual" });
  const quarterly = page.getByRole("button", { name: "quarterly" });
  // A 10-Q opens on its own series (roadmap 16.17).
  await expect(quarterly).toHaveAttribute("aria-pressed", "true");
  await expect(annual).toHaveAttribute("aria-pressed", "false");

  await annual.click();
  await expect(annual).toHaveAttribute("aria-pressed", "true");
  await expect(quarterly).toHaveAttribute("aria-pressed", "false");
});

test("a 10-K opens on the annual trend", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/1", (route) =>
    route.fulfill({ json: { ...ANALYSIS, form_type: "10-K" } }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByRole("button", { name: "annual" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the fallback trend plots only filings of the same form", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ status: 502, json: { detail: "EDGAR down" } }),
  );
  // NVDA's case: a year's revenue between two quarters'.
  await page.route("**/api/analysis?*", (route) =>
    route.fulfill({
      json: {
        analyses: [
          ANALYSIS,
          { ...ANALYSIS, id: 2, form_type: "10-K", filing_date: "2026-02-20", revenue_current: 4_000_000_000 },
          { ...ANALYSIS, id: 3, filing_date: "2025-11-01", revenue_current: 900_000_000 },
        ],
        total: 3,
      },
    }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByText("Trend Across Analyzed Filings")).toBeVisible();
  await expect(
    page.getByLabel("Line chart of AAPL revenue and net income across 2 periods"),
  ).toBeVisible();
});

test("search options show a CIK only to tell apart two filers with one name", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  const search = page.getByRole("combobox");

  await search.fill("AAPL");
  const option = page.getByRole("option", { name: /AAPL/ });
  await expect(option).toBeVisible();
  await expect(option).not.toContainText("CIK");

  await page.route("**/api/companies/search*", (route) =>
    route.fulfill({
      json: [
        { cik: "1001", ticker: "ACME", name: "Acme Corp" },
        { cik: "1002", ticker: "ACMEB", name: "ACME CORP" },
        COMPANY,
      ],
    }),
  );
  await search.fill("acme");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toContainText("CIK: 1001");
  await expect(options.nth(1)).toContainText("CIK: 1002");
  await expect(options.nth(2)).not.toContainText("CIK");
});

test("recent searches offered on focus after a selection", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  // Selecting a company records it in localStorage
  const input = page.getByRole("combobox");
  await input.fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page.getByText("Recent Filings for")).toBeVisible();

  // Fresh load: focusing the empty input offers the recent entry. Not a reload: the URL now
  // carries ?ticker=AAPL, which fills the box (roadmap 16.2).
  await page.goto("/");
  await page.getByRole("combobox").click();
  await expect(page.getByText("Recent", { exact: true })).toBeVisible();
  const option = page.getByRole("option", { name: /AAPL/ });
  await expect(option).toBeVisible();

  // Recents are Enter-selectable exactly like search results
  await page.getByRole("combobox").press("ArrowDown");
  await page.getByRole("combobox").press("Enter");
  await expect(page.getByText("Recent Filings for")).toBeVisible();
});

/** Roadmap 5.3. The stage checklist is only meaningful if the frames arrive
 * separately, so this one test drives a real chunked server; the rest of the
 * suite gets the same stream from a single `route.fulfill` body. */
test("streamed stages advance the checklist, then navigate", async ({
  page,
}) => {
  await mockApi(page);
  const sse = await startStageServer();
  await page.route("**/api/analysis", (route) =>
    route.request().method() === "POST"
      ? route.continue({ url: sse.url })
      : route.fallback(),
  );

  try {
    await page.goto("/");
    await page.getByRole("combobox").fill("AAPL");
    await page.getByRole("option", { name: /AAPL/ }).click();
    await page.getByRole("button", { name: "Analyze" }).click();

    const checklist = page.getByRole("listitem");
    await expect(
      page.getByText("Checking for a stored analysis"),
    ).toBeVisible();
    // Each stage becomes the current step in turn — the list is static, so
    // aria-current is what actually proves the stream is being read live.
    for (const label of [
      "Checking for a stored analysis",
      "Fetching the filing from EDGAR",
      "Extracting insights",
      "Saving the analysis",
    ]) {
      await expect(checklist.filter({ hasText: label })).toHaveAttribute(
        "aria-current",
        "step",
      );
    }

    await expect(page).toHaveURL(/\/analysis\/1$/);
    await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  } finally {
    await sse.close();
  }
});

test("a failed stream falls back to the unstreamed analysis", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/analysis", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const accept = route.request().headers()["accept"] ?? "";
    // Only the SSE attempt fails; the JSON retry behind it must still land the user
    // on the dashboard rather than showing an error.
    if (accept.includes("text/event-stream")) return route.abort("failed");
    await route.fulfill({ json: ANALYSIS });
  });

  await page.goto("/");
  await page.getByRole("combobox").fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page).toHaveURL(/\/analysis\/1$/);
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
});

/** roadmap 8.1 — the dashboard reads the classification off the stored analysis,
 * so no extra request is involved here (unlike the company page). */
test("the analysis dashboard shows the SEC industry classification", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await expect(page.getByTestId("industry-badge")).toHaveText(
    "SIC 3571 · Electronic Computers",
  );
});

test("the industry line links to the filtered history", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await page.getByTestId("industry-badge").getByRole("link").click();

  await expect(page).toHaveURL(/\/history\?sic=3571$/);
});

test("an analysis stored without a classification renders no industry line", async ({
  page,
}) => {
  await mockApi(page);
  // Rows analyzed before 8.1 landed, until the backfill runs.
  await page.route("**/api/analysis/1", (route) =>
    route.fulfill({
      json: { ...ANALYSIS, sic: null, sic_description: null, owner_org: null },
    }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByTestId("industry-badge")).toHaveCount(0);
});

/** roadmap 16.17 — "This filing" says what the headline figures do not: the margin. */
test("this filing shows net margin, not a redraw of the headline figures", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const section = page.locator("#this-filing");
  await expect(section.getByRole("heading", { name: "This filing" })).toBeVisible();
  await expect(section).toContainText("20.0%");
  await expect(section).toContainText(
    "net margin: net income of $200.0M on revenue of $1.00B",
  );
  await expect(section.locator("svg")).toHaveCount(0);
  const width = await section
    .getByTestId("margin-bar")
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(width).toBe("20%");
});

test("a net loss reads as a loss with an empty bar", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/1", (route) =>
    route.fulfill({ json: { ...ANALYSIS, net_income_current: -150_000_000 } }),
  );
  await page.goto("/analysis/1");

  const section = page.locator("#this-filing");
  await expect(section).toContainText("-15.0%");
  await expect(section).toContainText("a net loss of $150.0M on revenue of $1.00B");
  const width = await section
    .getByTestId("margin-bar")
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(width).toBe("0%");
});
