import { test, expect, type Page } from "@playwright/test";
import {
  ANALYSIS,
  ANALYSIS_FLAGGED,
  COMPANY,
  FLAG_EVENTS,
  flaggedFilingsFor,
  mockApi,
} from "./mocks";

/** The red-flag panel (roadmap 12.4): 8-K 4.01/4.02 and NT notices from the filings feed, and
 * going-concern / material-weakness flags stored on the analysis. */

const PANEL = { name: "Red flags" };

async function mockFlaggedCompany(page: Page) {
  await mockApi(page);
  await page.route("**/api/filings/**", (route) =>
    route.fulfill({
      json: flaggedFilingsFor(
        new URL(route.request().url()).searchParams.get("form_type") ?? "",
      ),
    }),
  );
}

test.describe("a company with red flags", () => {
  test.beforeEach(async ({ page }) => {
    await mockFlaggedCompany(page);
    await page.route("**/api/analysis*", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { analyses: [ANALYSIS_FLAGGED], total: 1 } });
      } else {
        await route.fallback();
      }
    });
    await page.goto(`/company/${COMPANY.ticker}`);
  });

  test("names each flag and links it to its source filing", async ({ page }) => {
    const panel = page.getByRole("region", PANEL);
    await expect(panel).toContainText("Change of auditor");
    await expect(panel).toContainText("Late filing notice (NT 10-K)");
    await expect(panel).toContainText("Going-concern doubt");
    await expect(panel).toContainText("raise substantial doubt");

    const link = panel.getByRole("link", { name: "8-K on SEC.gov" });
    await expect(link).toHaveAttribute(
      "href",
      `https://www.sec.gov/Archives/edgar/data/${COMPANY.cik}/${FLAG_EVENTS[0].accession_number.replace(/-/g, "")}/`,
    );
  });

  test("leaves out a flag older than three years", async ({ page }) => {
    const panel = page.getByRole("region", PANEL);
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Change of auditor")).toHaveCount(1);
  });

  test("keeps the late-filing notice out of the filing list", async ({ page }) => {
    await expect(page.getByRole("region", PANEL)).toBeVisible();
    await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(1);
  });

  test("sits below Recent Events, with only late sections under it", async ({ page }) => {
    // The CLS rule in frontend/CLAUDE.md: it renders nothing without a flag, so only another
    // late section may sit under it: the cross-filing ask, then Insider Activity.
    await expect(page.getByRole("region", PANEL)).toBeVisible();
    await expect(page.getByRole("region", { name: "Ask across filings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Insider activity" })).toBeVisible();
    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.at(-1)).toContain("Insider Activity");
    expect(headings.at(-2)).toContain("Ask Across Filings");
    expect(headings.at(-3)).toContain("Red Flags");
    expect(headings.at(-4)).toContain("Recent Events");
  });

  test("does not scroll sideways at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByRole("region", PANEL)).toContainText("substantial doubt");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});

test("AAPL shows no panel on either page", async ({ page }) => {
  // The acceptance criterion. Never a "no red flags" line either: silence is not health.
  await mockApi(page);
  await page.goto(`/company/${COMPANY.ticker}`);
  await expect(page.getByRole("region", { name: "Recent events" })).toBeVisible();
  await expect(page.getByRole("region", PANEL)).toHaveCount(0);
  await expect(page.getByText(/no red flags/i)).toHaveCount(0);

  await page.goto(`/analysis/${ANALYSIS.id}`);
  await expect(page.getByText("Key risk factors")).toBeVisible();
  await expect(page.getByRole("region", PANEL)).toHaveCount(0);
});

test.describe("the analysis page", () => {
  test.beforeEach(async ({ page }) => {
    await mockFlaggedCompany(page);
    await page.route("**/api/analysis/1", (route) =>
      route.fulfill({ json: ANALYSIS_FLAGGED }),
    );
    await page.goto(`/analysis/${ANALYSIS.id}`);
  });

  test("shows this filing's text flags beside the company's events", async ({ page }) => {
    const panel = page.getByRole("region", PANEL);
    await expect(panel).toContainText("Going-concern doubt");
    await expect(panel).toContainText("Change of auditor");
    await expect(panel).toContainText("Late filing notice (NT 10-K)");
  });

  test("sits directly above the risk factors", async ({ page }) => {
    // The placement the CLS reasoning depends on (AnalysisDashboard): the next section is the
    // one that already redraws when the events land.
    const panel = page.getByRole("region", PANEL);
    // The event flags arrive with the page's allSettled batch; measure after it has landed.
    await expect(panel).toContainText("Change of auditor");
    // Each dashboard section sits in its own wrapper div.
    const next = await panel.evaluate(
      (el) => el.parentElement?.nextElementSibling?.textContent ?? "",
    );
    expect(next).toContain("Key risk factors");
  });

  test("a failed events request still shows the stored text flags", async ({ page }) => {
    await page.route("**/api/filings/**", (route) => {
      const forms = new URL(route.request().url()).searchParams.get("form_type") ?? "";
      return forms.includes("NT 10-K")
        ? route.fulfill({ status: 502, json: { detail: "EDGAR down" } })
        : route.fallback();
    });
    await page.reload();
    const panel = page.getByRole("region", PANEL);
    await expect(panel).toContainText("Going-concern doubt");
    await expect(panel).not.toContainText("Change of auditor");
  });
});
