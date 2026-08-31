import { test, expect } from "@playwright/test";
import { FINANCIALS_MSFT, mockCompareApi } from "./mocks";

test("compare flow: pick two tickers, URL reflects the pair", async ({
  page,
}) => {
  await mockCompareApi(page);
  await page.goto("/compare");

  const boxes = page.getByRole("combobox");
  await boxes.nth(0).fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page).toHaveURL(/\/compare\?a=AAPL$/);
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(page.getByText("Apple Inc.")).toBeVisible();

  await boxes.nth(1).fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();
  await expect(page).toHaveURL(/\/compare\?a=AAPL&b=MSFT$/);
  await expect(page.getByText("No analysis yet for MSFT")).toBeVisible();
});

test("shared compare URL reproduces the view", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare?a=AAPL&b=AAPL");

  await expect(page.getByRole("heading", { name: "AAPL" })).toHaveCount(2);
  await expect(page.getByText("Apple Inc.")).toHaveCount(2);
});

test("invalid URL params degrade to the empty pickers", async ({ page }) => {
  await mockCompareApi(page);
  await page.goto("/compare?a=..%2Fetc&b=");

  // Both search boxes, both empty — the pickers are the empty state now, so
  // this asserts them directly rather than a sentence that repeated them.
  const boxes = page.getByRole("combobox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toHaveValue("");
  await expect(boxes.nth(1)).toHaveValue("");
});

test("trend overlay appears once both sides have a company", async ({
  page,
}) => {
  await mockCompareApi(page);
  await page.goto("/compare");

  const overlay = page.getByLabel(/Line chart comparing AAPL and MSFT/);
  const boxes = page.getByRole("combobox");

  await boxes.nth(0).fill("AAPL");
  await page.getByRole("option", { name: /AAPL/ }).click();
  await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
  await expect(overlay).toHaveCount(0);

  await boxes.nth(1).fill("MSFT");
  await page.getByRole("option", { name: /MSFT/ }).click();

  await expect(overlay).toBeVisible();
  for (const series of [
    "AAPL Revenue",
    "MSFT Revenue",
    "AAPL Net Income",
    "MSFT Net Income",
  ]) {
    await expect(overlay.getByText(series, { exact: true })).toBeVisible();
  }
});

test("trend overlay is absent when a company has too short a history", async ({
  page,
}) => {
  await mockCompareApi(page);
  await page.route("**/api/financials/789019", (route) =>
    route.fulfill({
      json: { ...FINANCIALS_MSFT, years: FINANCIALS_MSFT.years.slice(0, 1) },
    }),
  );
  await page.goto("/compare?a=AAPL&b=MSFT");

  await expect(page.getByText("No analysis yet for MSFT")).toBeVisible();
  await expect(page.getByLabel(/Line chart comparing/)).toHaveCount(0);
});
