import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks";

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
  await expect(page.getByText("Supply chain concentration risk.")).toBeVisible();
  await expect(page.getByText("Financial Trend")).toBeVisible();
  // Metrics table renders diluted EPS from the XBRL mock (roadmap 2.3)
  await expect(page.getByRole("cell", { name: "$6.42" })).toBeVisible();
  await expect(page.getByText("Revenue grew 5.5% year over year.")).toBeVisible();
  // Primary-source link (roadmap 1.4)
  await expect(
    page.getByRole("link", { name: "View filing on SEC.gov" })
  ).toHaveAttribute(
    "href",
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000057/"
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
