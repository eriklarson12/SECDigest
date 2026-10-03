import { test, expect } from "@playwright/test";
import {
  CHANGES_NEW,
  CHANGES_PRIOR,
  FILINGS,
  mockApi,
  mockChangesApi,
} from "./mocks";

/** The "what changed" page between two same-form filings (roadmap 12.2). */

const URL = `/analysis/${CHANGES_NEW.id}/changes`;

test("renders all five sections in order against the prior 10-K", async ({ page }) => {
  await mockChangesApi(page);
  await page.goto(URL);

  await expect(page.getByRole("heading", { name: "AAPL: what changed" })).toBeVisible();
  await expect(page.getByText("10-K filed Oct 31, 2025 vs 10-K filed Nov 1, 2024")).toBeVisible();

  const headings = [
    "Headline figures",
    "Key risk factors",
    "Changed since Nov 1, 2024",
    "Events between",
  ];
  const tops: number[] = [];
  for (const name of headings) {
    const heading = page.getByRole("heading", { name });
    await expect(heading).toBeVisible();
    tops.push((await heading.boundingBox())!.y);
  }
  const revisions = page.getByText("Revisions to previously reported figures (1)");
  await expect(revisions).toBeVisible();
  tops.push((await revisions.boundingBox())!.y);
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
});

test("headline figures match the financials payload", async ({ page }) => {
  await mockChangesApi(page);
  await page.goto(URL);

  const table = page.getByRole("region", { name: "Headline figures" }).getByRole("table");
  await expect(table.getByRole("columnheader", { name: "FY2024" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "FY2025" })).toBeVisible();

  const revenue = table.getByRole("row", { name: /Revenue/ });
  await expect(revenue).toContainText("$400.00B");
  await expect(revenue).toContainText("$440.00B");
  await expect(revenue).toContainText("▲ 10.0%");
  // A change off a loss has no honest percentage.
  const netIncome = table.getByRole("row", { name: /Net income/ });
  await expect(netIncome).toContainText("$-2.00B");
  await expect(netIncome).not.toContainText("%");
  await expect(table.getByRole("row", { name: /Diluted EPS/ })).toContainText("$7.46");
  await expect(table.getByRole("row", { name: /Operating cash flow/ })).toContainText("▼");
});

test("diffs risks, windows the 8-Ks and keeps only this filing's revisions", async ({ page }) => {
  await mockChangesApi(page);
  await page.goto(URL);

  const risks = page.getByRole("region", { name: "Risk factors" });
  await expect(risks.getByText("New")).toHaveCount(1);
  await expect(risks).toContainText("Foreign exchange rates reduce reported revenue.");

  const events = page.getByRole("region", { name: "Events between" }).getByRole("listitem");
  await expect(events).toHaveCount(2);
  await expect(events.nth(0)).toContainText("Oct 30, 2025");
  await expect(events.nth(1)).toContainText("Feb 14, 2025");

  const revisions = page.getByRole("region", { name: "Revisions" });
  await expect(revisions.getByRole("listitem")).toHaveCount(1);
  await expect(revisions).toContainText("FY2024");
});

test("a filing with no same-form prior asks for one", async ({ page }) => {
  await mockChangesApi(page);
  // The only earlier analysis is a 10-Q: a mixed pair is never built.
  await page.route("**/api/analysis*", (route) =>
    route.fulfill({
      json: {
        analyses: [CHANGES_NEW, { ...CHANGES_PRIOR, form_type: "10-Q" }],
        total: 2,
      },
    }),
  );
  await page.goto(URL);

  await expect(page.getByText("Pick a same-form filing")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Analyze an earlier 10-K" }),
  ).toHaveAttribute("href", "/company/AAPL");
  await expect(page.getByRole("region", { name: "Headline figures" })).toHaveCount(0);
});

test("a failed drift fetch retries on its own", async ({ page }) => {
  await mockChangesApi(page);
  // A flag, not a call count: Strict Mode runs the page's effect twice in dev.
  let fail = true;
  await page.route("**/api/analysis/*/drift", async (route) => {
    if (fail) await route.fulfill({ status: 500, json: { detail: "boom" } });
    else await route.fallback();
  });
  await page.goto(URL);

  // The rest of the page stands while one section fails.
  await expect(page.getByRole("heading", { name: "Headline figures" })).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toHaveCount(1);
  fail = false;
  await retry.click();
  await expect(page.getByRole("heading", { name: "Changed since Nov 1, 2024" })).toBeVisible();
});

test("the drift card links to the page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  await expect(
    page.getByRole("link", { name: "Everything that changed since the prior filing" }),
  ).toHaveAttribute("href", "/analysis/1/changes");
});

test("the newer-filing banner links to the page when both filings are analyzed", async ({ page }) => {
  await mockChangesApi(page);
  await page.route("**/api/filings/**", (route) =>
    route.fulfill({
      json: [
        {
          ...FILINGS[0],
          accession_number: CHANGES_NEW.accession_number,
          form_type: "10-K",
          filing_date: CHANGES_NEW.filing_date,
        },
      ],
    }),
  );
  await page.goto(`/analysis/${CHANGES_PRIOR.id}`);

  await expect(
    page.getByRole("status").getByRole("link", { name: "see what changed" }),
  ).toHaveAttribute("href", URL);
});

test("does not scroll sideways at 375px", async ({ page }) => {
  await mockChangesApi(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(URL);

  await expect(page.getByText("Revisions to previously reported figures (1)")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
