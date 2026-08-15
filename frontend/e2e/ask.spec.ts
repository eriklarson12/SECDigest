import { test, expect, type Page } from "@playwright/test";
import {
  mockApi,
  ASK_ANSWER,
  ASK_ANSWER_CONVERTED,
  ASK_ANSWER_NO_SCALE,
  INDEX_COMPLETE,
  INDEX_IN_PROGRESS,
} from "./mocks";

/** "Ask this filing" — RAG Q&A card on the analysis dashboard (roadmap 5.1). */

const ASK_INPUT = { name: "Ask a question about this filing" };

/** goto() resolves on the server HTML, before React hydrates. A fill() landing in
 * that window sets the DOM value without firing onChange, so AskFiling's controlled
 * `question` stays empty and its Ask button never enables. Retry until it registers. */
async function typeQuestion(page: Page, question: string) {
  const input = page.getByRole("textbox", ASK_INPUT);
  const button = page.getByRole("button", { name: "Ask" });

  await expect(async () => {
    await input.fill(question);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  return { input, button };
}

test("ask a question → cited answer", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const { button } = await typeQuestion(page, "What are the main revenue drivers?");
  await button.click();

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();

  const sources = page.getByText("Sources (2)");
  await expect(sources).toBeVisible();
  await expect(page.getByText(ASK_ANSWER.sources[0]!.excerpt)).toBeHidden();
  await sources.click();
  await expect(page.getByText(ASK_ANSWER.sources[0]!.excerpt)).toBeVisible();
  await expect(page.getByText(ASK_ANSWER.sources[1]!.excerpt)).toBeVisible();
});

test("the answer carries the filing's unit scale", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const { button } = await typeQuestion(
    page,
    "What does management say about liquidity?"
  );
  await button.click();

  // Without this, "$11,133" reads a million times too small. "as filed" avoids
  // contradicting an answer that already converted the figure.
  await expect(
    page.getByText(
      "Source figures as filed: amounts in millions, except per share data."
    )
  ).toBeVisible();
});

test("a converted figure keeps the caption readable as a source fact", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/ask", (route) =>
    route.fulfill({ json: ASK_ANSWER_CONVERTED }),
  );
  await page.goto("/analysis/1");

  const { button } = await typeQuestion(page, "What drove the change in revenue?");
  await button.click();

  // "$932 million" above a bare "In thousands." reads as a contradiction
  await expect(
    page.getByText("Source figures as filed: in thousands.")
  ).toBeVisible();
});

test("a filing that declares no scale shows no caption", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/ask", (route) =>
    route.fulfill({ json: ASK_ANSWER_NO_SCALE }),
  );
  await page.goto("/analysis/1");

  const { button } = await typeQuestion(
    page,
    "What does management say about liquidity?"
  );
  await button.click();

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
  await expect(page.getByText(/^Source figures as filed:/)).toBeHidden();
});

test("keyboard-only: Enter submits the question", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const { input } = await typeQuestion(page, "What are the main revenue drivers?");
  await input.press("Enter");

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
});

test("a suggested question asks in one click and fills the input", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const SUGGESTION = "Which risks does the company describe as most significant?";
  const input = page.getByRole("textbox", ASK_INPUT);

  // Same pre-hydration window as typeQuestion: a click before React attaches its
  // handler is a no-op. Re-asking is harmless — the route mock is idempotent.
  await expect(async () => {
    await page.getByRole("button", { name: SUGGESTION }).click();
    await expect(input).toHaveValue(SUGGESTION, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
});

test("un-indexed filing shows the friendly Q&A-unavailable copy", async ({
  page,
}) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/ask", (route) =>
    route.fulfill({
      status: 404,
      json: { detail: "Q&A isn't available for this filing" },
    })
  );
  await page.goto("/analysis/1");

  const { button } = await typeQuestion(page, "What are the main revenue drivers?");
  await button.click();

  // Filter: Next's route announcer is also role=alert.
  await expect(
    page.getByRole("alert").filter({ hasText: "Q&A isn't available" })
  ).toBeVisible();
});

/** Indexing moved to a background job, so coverage ramps up after an analysis
 * instead of arriving complete — these cover that being visible, not blocking. */

test("a filing still indexing says so without blocking questions", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/index-status", (route) =>
    route.fulfill({ json: INDEX_IN_PROGRESS })
  );
  await page.goto("/analysis/1");

  await expect(
    page.getByText("Still indexing the full filing (24 of 102 passages)")
  ).toBeVisible();

  // The already-indexed passages still answer, so the input stays usable
  const { input, button } = await typeQuestion(
    page,
    "What are the main revenue drivers?"
  );
  await expect(input).toBeEnabled();
  await button.click();
  await expect(page.getByText(ASK_ANSWER.answer)).toBeVisible();
});

test("the indexing notice clears when the background job finishes", async ({ page }) => {
  await mockApi(page);
  // Flipped by the test rather than counted by poll number, so a re-mount or an
  // extra poll can't race the assertion.
  let status = INDEX_IN_PROGRESS;
  await page.route("**/api/analysis/*/index-status", (route) =>
    route.fulfill({ json: status })
  );
  await page.goto("/analysis/1");

  const notice = page.getByText("Still indexing the full filing");
  await expect(notice).toBeVisible();

  status = INDEX_COMPLETE;
  // Polling is on a 5s timer, so allow more than one interval
  await expect(notice).toBeHidden({ timeout: 15_000 });
});

test("a filing with no chunks says Q&A is unavailable up front", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/analysis/*/index-status", (route) =>
    route.fulfill({ json: { state: "unavailable", chunks_indexed: 0, chunks_total: 0 } })
  );
  await page.goto("/analysis/1");

  await expect(page.getByText("Q&A isn't available for this filing.")).toBeVisible();
});

test("the Ask button is disabled until a question is typed", async ({ page }) => {
  await mockApi(page);
  await page.goto("/analysis/1");

  const button = page.getByRole("button", { name: "Ask" });
  await expect(button).toBeDisabled();

  await typeQuestion(page, "What are the main revenue drivers?");
  await expect(button).toBeEnabled();
});
