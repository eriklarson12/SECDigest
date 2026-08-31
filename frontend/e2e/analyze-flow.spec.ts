import { test, expect } from "@playwright/test";
import { ANALYSIS, mockApi, startStageServer } from "./mocks";

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
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000057/",
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
  await expect(annual).toBeVisible();
  await expect(annual).toHaveAttribute("aria-pressed", "true");

  await quarterly.click();
  await expect(quarterly).toHaveAttribute("aria-pressed", "true");
  await expect(annual).toHaveAttribute("aria-pressed", "false");
});

test("recent searches offered on focus after a selection", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  // Selecting a company records it in localStorage
  const input = page.getByRole("combobox");
  await input.fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page.getByText("Recent Filings for")).toBeVisible();

  // Fresh load: focusing the empty input offers the recent entry
  await page.reload();
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
