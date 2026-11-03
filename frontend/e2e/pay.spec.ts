import { test, expect } from "@playwright/test";
import { COMPANY, FINANCIALS, PAY, mockApi } from "./mocks";

/** Pay versus performance (roadmap 15.1): the proxy's CEO pay against shareholder return. */

const SECTION = { name: "Pay versus performance" };

test.describe("a company with a tagged table", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("shows a row per CEO per year, with the company's own measure", async ({ page }) => {
    await page.goto(`/company/${COMPANY.ticker}`);
    const section = page.getByRole("region", SECTION);
    // A header row, then FY2025, two CEOs in FY2024, and FY2023.
    await expect(section.getByRole("row")).toHaveCount(5);
    await expect(section.getByRole("columnheader", { name: "Net Sales" })).toBeVisible();
    await expect(section.getByRole("columnheader", { name: "Peer TSR" })).toBeVisible();

    const latest = section.getByRole("row").nth(1);
    await expect(latest).toContainText("Sep 27, 2025");
    await expect(latest).toContainText("Mr. Cook");
    await expect(latest).toContainText("$74.3M");
    await expect(latest).toContainText("$108.4M");
    await expect(latest).toContainText("$233.88");
    await expect(latest).toContainText("$416.16B");

    const interim = section.getByRole("row", { name: /Jane Interim/ });
    await expect(interim).toContainText("Sep 28, 2024");
    await expect(interim).toContainText("$-409,935");
  });

  test("takes net income from the 10-K figures by period end", async ({ page }) => {
    const years = FINANCIALS.years.map((y) =>
      y.fiscal_year === 2025 ? { ...y, period_end: "2025-09-27" } : y,
    );
    await page.route("**/api/financials/**", (route) =>
      route.fulfill({ json: { ...FINANCIALS, years } }),
    );
    await page.goto(`/company/${COMPANY.ticker}`);
    const rows = page.getByRole("region", SECTION).getByRole("row");
    await expect(rows.nth(1)).toContainText("$200.0M");
    // No 10-K year ends on 2024-09-28 in this fixture, so that cell is a gap.
    await expect(rows.nth(2).getByRole("cell").nth(6)).toHaveText("—");
  });

  test("waits for financials, so net income never fills in late", async ({ page }) => {
    const years = FINANCIALS.years.map((y) =>
      y.fiscal_year === 2025 ? { ...y, period_end: "2025-09-27" } : y,
    );
    await page.route("**/api/financials/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ json: { ...FINANCIALS, years } });
    });
    await page.goto(`/company/${COMPANY.ticker}`);
    const section = page.getByRole("region", SECTION);
    await section.waitFor();
    // Read once, without retrying: the first render must already carry the figure.
    expect(await section.getByRole("row").nth(1).innerText()).toContain("$200.0M");
  });

  test("links the proxy and explains the columns", async ({ page }) => {
    await page.goto(`/company/${COMPANY.ticker}`);
    const section = page.getByRole("region", SECTION);
    await expect(section).toContainText(
      "From the pay-versus-performance table in the latest proxy filed Jan 8, 2026.",
    );
    await expect(section).toContainText("so it can be negative");
    await expect(section.getByRole("link", { name: "Proxy on SEC.gov" })).toHaveAttribute(
      "href",
      `https://www.sec.gov/Archives/edgar/data/${COMPANY.cik}/${PAY.accession_number.replace(/-/g, "")}/`,
    );
  });

  test("sits last, directly below insider activity", async ({ page }) => {
    await page.goto(`/company/${COMPANY.ticker}`);
    await expect(page.getByRole("region", SECTION)).toBeVisible();
    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.at(-1)).toContain("Pay Versus Performance");
    expect(headings.at(-2)).toContain("Insider Activity");
  });

  test("does not scroll sideways at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/company/${COMPANY.ticker}`);
    await expect(page.getByRole("region", SECTION)).toContainText("Jane Interim");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});

test("a smaller reporting company has no peer or measure columns", async ({ page }) => {
  await mockApi(page);
  const years = PAY.years.map((y) => ({ ...y, peer_tsr: null, measure_value: null, measure_unit: null }));
  await page.route("**/api/companies/*/pay", (route) =>
    route.fulfill({ json: { ...PAY, measure_name: null, years } }),
  );
  await page.goto(`/company/${COMPANY.ticker}`);
  const section = page.getByRole("region", SECTION);
  await expect(section.getByRole("columnheader")).toHaveCount(6);
  await expect(section.getByRole("columnheader", { name: "Peer TSR" })).toHaveCount(0);
});

test("a proxy with no tagged table says so in one line", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/companies/*/pay", (route) =>
    route.fulfill({ json: { ...PAY, measure_name: null, years: [] } }),
  );
  await page.goto(`/company/${COMPANY.ticker}`);
  const section = page.getByRole("region", SECTION);
  await expect(section).toContainText(
    "No tagged pay-versus-performance table in the latest proxy.",
  );
  await expect(section.getByRole("table")).toHaveCount(0);
  await expect(section.getByRole("link", { name: "Proxy on SEC.gov" })).toBeVisible();
});

test("a failed load offers a retry that recovers", async ({ page }) => {
  await mockApi(page);
  // A flag, not a call count: Strict Mode runs the page effect twice in dev.
  let failing = true;
  await page.route("**/api/companies/*/pay", (route) =>
    failing ? route.fulfill({ status: 502, json: { detail: "x" } }) : route.fallback(),
  );
  await page.goto(`/company/${COMPANY.ticker}`);
  const section = page.getByRole("region", SECTION);
  const retry = section.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();

  failing = false;
  await retry.click();
  await expect(section.getByRole("row")).toHaveCount(5);
});
