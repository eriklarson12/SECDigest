import { test, expect, type Page } from "@playwright/test";
import { ANALYZED_FILING, COMPANY, FILINGS, mockApi } from "./mocks";

/** A filing row says what a click will do (roadmap 16.1): a stored filing links to its
 * analysis, and the rest still run the pipeline. */

const UNANALYZED = {
  ...FILINGS[0],
  accession_number: "0000320193-25-000079",
  form_type: "10-K",
  filing_date: "2025-10-31",
  primary_document: "aapl-10k.htm",
  primary_doc_description: "10-K",
};

const VIEW = "View analysis of 10-Q filed May 2, 2026";
const ANALYZE = "Analyze 10-K filed Oct 31, 2025";

/** Two rows, one stored. `release` holds the history response until a test lets it go. */
async function mockStoredRow(page: Page, held = false) {
  await mockApi(page);
  await page.route("**/api/filings/**", (route) =>
    route.fulfill({ json: [FILINGS[0], UNANALYZED] }),
  );
  let release = () => {};
  const gate = held ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  await page.route("**/api/analysis?*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await gate;
    await route.fulfill({ json: { analyses: [ANALYZED_FILING], total: 1 } });
  });
  await page.route(`**/api/analysis/${ANALYZED_FILING.id}`, (route) =>
    route.fulfill({ json: ANALYZED_FILING }),
  );
  return () => release();
}

test("a stored filing links to its analysis and the rest still analyze", async ({ page }) => {
  await mockStoredRow(page);
  await page.goto(`/?ticker=${COMPANY.ticker}`);

  const view = page.getByRole("link", { name: VIEW });
  await expect(view).toHaveAttribute("href", `/analysis/${ANALYZED_FILING.id}`);
  await expect(page.getByRole("link", { name: /^View analysis/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: ANALYZE })).toBeEnabled();
});

test("View analysis opens the stored analysis without running the pipeline", async ({
  page,
}) => {
  await mockStoredRow(page);
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/analysis")) posts += 1;
  });
  await page.goto(`/?ticker=${COMPANY.ticker}`);
  await page.getByRole("link", { name: VIEW }).click();

  await expect(page).toHaveURL(new RegExp(`/analysis/${ANALYZED_FILING.id}$`));
  await expect(page.getByRole("heading", { name: COMPANY.ticker })).toBeVisible();
  expect(posts).toBe(0);
});

test("the company page relabels from the history it already loads", async ({ page }) => {
  await mockStoredRow(page);
  await page.goto(`/company/${COMPANY.ticker}`);

  const filings = page.getByRole("region", { name: "Recent filings" });
  await expect(filings.getByRole("link", { name: VIEW })).toHaveAttribute(
    "href",
    `/analysis/${ANALYZED_FILING.id}`,
  );
  await expect(filings.getByRole("button", { name: ANALYZE })).toBeVisible();
});

// 375px is where a row's left half has the least room, so a wider label would wrap it there first.
for (const width of [1024, 375]) {
  test(`history landing late relabels the row and moves nothing at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const release = await mockStoredRow(page, true);
    await page.goto(`/?ticker=${COMPANY.ticker}`);

    await expect(
      page.getByRole("button", { name: "Analyze 10-Q filed May 2, 2026" }),
    ).toBeVisible();
    // Anchored on the row that keeps its label, since the other one's control is replaced.
    const list = page.getByRole("button", { name: ANALYZE }).locator("xpath=../..");
    const before = await list.boundingBox();

    release();
    await expect(page.getByRole("link", { name: VIEW })).toBeVisible();
    const after = await list.boundingBox();
    expect(after?.height).toBe(before?.height);
    expect(after?.y).toBe(before?.y);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });
}
