import { test, expect } from "@playwright/test";
import { COMPANY, EARNINGS, mockApi } from "./mocks";

/** Earnings-release summaries (roadmap 15.3): a Summarize control on 2.02 events in Recent Events. */

const EVENTS = { name: "Recent events" };
const PANEL = { name: "Earnings release summary" };

test.describe("an earnings release with no stored summary", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("offers Summarize on the 2.02 event only", async ({ page }) => {
    await page.goto(`/company/${COMPANY.ticker}`);
    const events = page.getByRole("region", EVENTS);
    await expect(events.getByRole("listitem")).toHaveCount(3);
    await expect(events.getByRole("button", { name: "Summarize" })).toHaveCount(1);
    const row = events.getByRole("listitem").filter({ hasText: "Results of Operations" });
    await expect(row.getByRole("button", { name: "Summarize" })).toBeVisible();
  });

  test("summarizes on a click and shows each figure with its quote", async ({ page }) => {
    let release: (() => void) | null = null;
    const posted: string[] = [];
    await page.route("**/api/companies/*/earnings/*", async (route) => {
      posted.push(new URL(route.request().url()).pathname);
      await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: EARNINGS });
    });
    await page.goto(`/company/${COMPANY.ticker}`);
    const events = page.getByRole("region", EVENTS);
    await events.getByRole("button", { name: "Summarize" }).click();

    await expect(events.getByRole("button", { name: "Summarizing…" })).toBeDisabled();
    release!();

    const panel = events.getByRole("region", PANEL);
    await expect(panel).toContainText("Apple posted June-quarter revenue of $94.0 billion");
    await expect(panel.getByRole("definition").filter({ hasText: /^\$1\.57$/ })).toBeVisible();
    await expect(panel).toContainText(
      "“Diluted earnings per share was $1.57, up 12 percent year over year.”",
    );
    await expect(panel.getByText("Guidance", { exact: true })).toHaveCount(1);
    await expect(panel.getByRole("link", { name: "Release on SEC.gov" })).toHaveAttribute(
      "href",
      `https://www.sec.gov/Archives/edgar/data/320193/000032019326000068/${EARNINGS.document}`,
    );
    expect(posted).toEqual([`/api/companies/${COMPANY.cik}/earnings/0000320193-26-000068`]);

    await events.getByRole("button", { name: "Hide summary" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("a spent daily budget shows the reason, and a second click recovers", async ({ page }) => {
    let failing = true;
    await page.route("**/api/companies/*/earnings/*", (route) =>
      failing
        ? route.fulfill({
            status: 503,
            headers: { "Retry-After": "3600" },
            json: { detail: "Daily analysis capacity reached — try again tomorrow" },
          })
        : route.fallback(),
    );
    await page.goto(`/company/${COMPANY.ticker}`);
    const events = page.getByRole("region", EVENTS);
    await events.getByRole("button", { name: "Summarize" }).click();
    await expect(events.getByRole("alert")).toBeVisible();
    await expect(events.getByRole("region", PANEL)).toHaveCount(0);

    failing = false;
    await events.getByRole("button", { name: "Summarize" }).click();
    await expect(events.getByRole("region", PANEL)).toBeVisible();
    await expect(events.getByRole("alert")).toHaveCount(0);
  });

  test("does not scroll sideways at 375px with a summary open", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/company/${COMPANY.ticker}`);
    const events = page.getByRole("region", EVENTS);
    await events.getByRole("button", { name: "Summarize" }).click();
    await expect(events.getByRole("region", PANEL)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});

test.describe("an earnings release already summarized", () => {
  test("shows the stored summary without generating one", async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/companies/*/earnings", (route) =>
      route.fulfill({ json: [EARNINGS] }),
    );
    let posts = 0;
    await page.route("**/api/companies/*/earnings/*", (route) => {
      posts += 1;
      return route.fulfill({ json: EARNINGS });
    });
    await page.goto(`/company/${COMPANY.ticker}`);
    const events = page.getByRole("region", EVENTS);
    await events.getByRole("button", { name: "Show summary" }).click();
    await expect(events.getByRole("region", PANEL)).toContainText("$94.0 billion");
    expect(posts).toBe(0);
  });

  test("a stored summary landing late relabels the control and moves nothing", async ({
    page,
  }) => {
    await mockApi(page);
    let release: (() => void) | null = null;
    await page.route("**/api/companies/*/earnings", async (route) => {
      await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: [EARNINGS] });
    });
    await page.goto(`/company/${COMPANY.ticker}`);
    const events = page.getByRole("region", EVENTS);
    await expect(events.getByRole("button", { name: "Summarize" })).toBeVisible();
    const before = await events.boundingBox();

    release!();
    await expect(events.getByRole("button", { name: "Show summary" })).toBeVisible();
    const after = await events.boundingBox();
    expect(after?.height).toBe(before?.height);
  });
});
