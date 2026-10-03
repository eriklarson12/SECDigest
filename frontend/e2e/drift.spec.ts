import { test, expect } from "@playwright/test";
import { DRIFT, DRIFT_NOT_INDEXED, DRIFT_NO_PRIOR, mockApi } from "./mocks";

/** "Changed since" — language drift on the analysis dashboard (roadmap 12.1). */

const CARD = { name: "Language drift" };

test("shows the share carried over and the changed passages", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const card = page.getByRole("region", CARD);
  await expect(
    card.getByRole("heading", { name: "Changed since Jan 30, 2026" }),
  ).toBeVisible();
  await expect(card).toContainText("96%");
  await expect(card).toContainText("of passages carried over from the 10-Q filed Jan 30, 2026");
  const passages = card.getByRole("listitem");
  await expect(passages).toHaveCount(DRIFT.novel_passages.length);
  await expect(passages.first()).toContainText("component suppliers may fail");
  // No counterpart: the old side says so rather than quoting something unrelated.
  await expect(passages.first()).toContainText("Nothing close: this wording is new.");
  await expect(passages.nth(1)).toContainText("Closest in the 10-Q filed Jan 30, 2026");
  await expect(passages.nth(1)).toContainText(
    "In addition to intense competition for talent, workforce dynamics are constantly evolving.",
  );
});

test("passages stack at 375px and sit side by side on a wide screen", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/analysis/1");

  const pair = page.getByRole("region", CARD).getByRole("listitem").nth(1).locator("blockquote");
  await expect(pair).toHaveCount(2);
  let [now, before] = [(await pair.nth(0).boundingBox())!, (await pair.nth(1).boundingBox())!];
  expect(before.y).toBeGreaterThan(now.y + now.height - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
  ).toBe(false);

  await page.setViewportSize({ width: 1200, height: 900 });
  [now, before] = [(await pair.nth(0).boundingBox())!, (await pair.nth(1).boundingBox())!];
  expect(before.x).toBeGreaterThan(now.x + now.width - 1);
});

test("sits right below the risk factors", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const risks = page.getByRole("heading", { name: "Key risk factors" });
  const card = page.getByRole("region", CARD);
  await expect(card).toBeVisible();
  const riskBox = (await risks.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  const askBox = (await page.getByRole("textbox", { name: "Ask a question about this filing" }).boundingBox())!;
  expect(cardBox.y).toBeGreaterThan(riskBox.y);
  expect(cardBox.y).toBeLessThan(askBox.y);
});

test("names the missing prior in one line, with no card", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/drift", (route) =>
    route.fulfill({ json: DRIFT_NO_PRIOR }),
  );
  await page.goto("/analysis/1");

  await expect(
    page.getByText("No earlier 10-Q has been analyzed here to compare this filing's wording against."),
  ).toBeVisible();
  await expect(page.getByRole("region", CARD)).toHaveCount(0);
});

test("says indexing is outstanding in one line", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/drift", (route) =>
    route.fulfill({ json: DRIFT_NOT_INDEXED }),
  );
  await page.goto("/analysis/1");

  await expect(
    page.getByText("Wording is compared with the 10-Q filed Jan 30, 2026 once both filings finish indexing."),
  ).toBeVisible();
  await expect(page.getByRole("region", CARD)).toHaveCount(0);
});

test("renders nothing when the drift request fails", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/drift", (route) =>
    route.fulfill({ status: 500, json: { detail: "Internal server error" } }),
  );
  await page.goto("/analysis/1");

  await expect(page.getByRole("heading", { name: "Key risk factors" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask a question about this filing" })).toBeVisible();
  await expect(page.getByRole("region", CARD)).toHaveCount(0);
  await expect(page.getByText("Changed since")).toHaveCount(0);
});
