import { test, expect } from "@playwright/test";
import { COMPANY, INSIDERS, INSIDERS_NO_TRADES, mockApi } from "./mocks";

/** The insider-activity strip (roadmap 12.5): open-market Form 4 trades from the last 90 days. */

const STRIP = { name: "Insider activity" };

test.describe("a company with insider trades", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto(`/company/${COMPANY.ticker}`);
  });

  test("shows the net figure, the 10b5-1 count and the source", async ({ page }) => {
    const strip = page.getByRole("region", STRIP);
    await expect(strip).toContainText("▼ Net sold 2,000 shares ($600,000)");
    await expect(strip).toContainText(
      "5 of 6 trades were scheduled in advance under a Rule 10b5-1 plan.",
    );
    await expect(strip).toContainText(
      "From the 9 Form 4s filed in the last 90 days. Open-market trades only.",
    );
  });

  test("lists the latest five trades, each linked to its Form 4", async ({ page }) => {
    const strip = page.getByRole("region", STRIP);
    await expect(strip.getByRole("listitem")).toHaveCount(5);
    await expect(strip).toContainText("Sale 2,399 shares at $336.18");
    await expect(strip).not.toContainText("Doe John");
    await expect(strip.getByText("10b5-1 plan", { exact: true })).toHaveCount(5);

    const link = strip.getByRole("link", { name: "Form 4 on SEC.gov" }).first();
    await expect(link).toHaveAttribute(
      "href",
      `https://www.sec.gov/Archives/edgar/data/${COMPANY.cik}/${INSIDERS.transactions[0].accession_number.replace(/-/g, "")}/`,
    );
  });

  test("sits last on the page", async ({ page }) => {
    await expect(page.getByRole("region", STRIP)).toBeVisible();
    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.at(-1)).toContain("Insider Activity");
  });

  test("does not scroll sideways at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByRole("region", STRIP)).toContainText("SVP, GC and Government Affairs");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});

test("a company with no open-market trades says so in one line", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/companies/*/insiders", (route) =>
    route.fulfill({ json: INSIDERS_NO_TRADES }),
  );
  await page.goto(`/company/${COMPANY.ticker}`);
  const strip = page.getByRole("region", STRIP);
  await expect(strip).toContainText(
    "No open-market buys or sells in the last 90 days. 13 Form 4s reported other transactions",
  );
  await expect(strip.getByRole("listitem")).toHaveCount(0);
  await expect(strip).not.toContainText("Net sold");
});

test("a failed request shows an error that retries", async ({ page }) => {
  await mockApi(page);
  let calls = 0;
  await page.route("**/api/companies/*/insiders", (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ status: 502, json: { detail: "EDGAR down" } })
      : route.fulfill({ json: INSIDERS });
  });
  await page.goto(`/company/${COMPANY.ticker}`);
  const strip = page.getByRole("region", STRIP);
  await strip.getByRole("button", { name: "Retry" }).click();
  await expect(strip).toContainText("Net sold 2,000 shares");
});
