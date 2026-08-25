import { test, expect, type Page } from "@playwright/test";
import { COMPANY, FILINGS, mockApi } from "./mocks";

/** roadmap 4.5 — the All / 10-K / 10-Q control on both filings surfaces. */

const TENK = {
  accession_number: "0000320193-25-000106",
  form_type: "10-K",
  filing_date: "2025-11-01",
  primary_document: "aapl-10k.htm",
  primary_doc_description: "10-K",
};

/** Re-registers the filings route so it honours form_type. Later registrations win,
 * so this shadows mockApi's without disturbing the shared FILINGS fixture.
 * `requested` collects every form_type sent; assert on its last entry only —
 * Strict Mode double-invokes effects under `next dev` but not the CI build. */
async function mockFilingsByForm(page: Page, requested: string[]) {
  await page.route("**/api/filings/**", async (route) => {
    const formType =
      new URL(route.request().url()).searchParams.get("form_type") ?? "";
    requested.push(formType);
    const wanted = formType.split(",");
    const all = [...FILINGS, TENK];
    await route.fulfill({ json: all.filter((f) => wanted.includes(f.form_type)) });
  });
}

test("filtering the homepage filing list sends form_type and swaps the rows", async ({
  page,
}) => {
  const requested: string[] = [];
  await mockApi(page);
  await mockFilingsByForm(page, requested);
  await page.goto("/");

  await page.getByRole("combobox").fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page.getByText("Recent Filings for")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(2);
  expect(requested.at(-1)).toBe("10-K,10-Q");

  await page.getByRole("button", { name: "10-K", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(1);
  // The badge, not the date: formatDate renders in the runner's local timezone.
  await expect(page.locator("span.font-mono").filter({ hasText: "10-K" })).toHaveCount(1);
  expect(requested.at(-1)).toBe("10-K");
  await expect(page.getByRole("button", { name: "10-K", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(2);
  expect(requested.at(-1)).toBe("10-K,10-Q");
});

test("the company page filing list filters the same way", async ({ page }) => {
  const requested: string[] = [];
  await mockApi(page);
  await mockFilingsByForm(page, requested);
  await page.goto(`/company/${COMPANY.ticker}`);

  await expect(page.getByText("Recent Filings")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(2);

  await page.getByRole("button", { name: "10-Q", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyze" })).toHaveCount(1);
  expect(requested.at(-1)).toBe("10-Q");
});

test("an empty filter result keeps the control reachable", async ({ page }) => {
  await mockApi(page);
  // This company has filed no 10-K, so the filter strands the user unless the
  // control renders alongside the empty state.
  await page.route("**/api/filings/**", async (route) => {
    const formType =
      new URL(route.request().url()).searchParams.get("form_type") ?? "";
    await route.fulfill({ json: formType === "10-K" ? [] : FILINGS });
  });
  await page.goto("/");

  await page.getByRole("combobox").fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();

  await page.getByRole("button", { name: "10-K", exact: true }).click();
  await expect(page.getByText("No 10-K filings found")).toBeVisible();

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyze" })).toBeVisible();
});
