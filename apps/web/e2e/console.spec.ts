import { expect, test } from "@playwright/test";
import { SECTION_NAV } from "../src/lib/sections";
import { jobFixture, questionFixture } from "../src/test/fixtures";
import type { JobView, QuestionLog } from "../src/lib/types";
import { MockApiError, mockApi, trackConsoleErrors } from "./mockApi";

test("the console loads at / and lands on Ask with live data", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const api = await mockApi(page, {
    "GET /questions": () => ({
      questions: [questionFixture({ question: "What are urgent cat warning signs?" })],
      total: 12,
      matching: 12
    })
  });

  await page.goto("/");

  // The root route redirects to the default section.
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.getByRole("heading", { name: "Ask a Question" })).toBeVisible();
  // The first refresh landed: the topbar reports it and the list shows the logged question.
  await expect(page.getByText(/^Updated /)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What are urgent cat warning signs?" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Console sections" });
  await expect(nav.getByRole("link")).toHaveCount(SECTION_NAV.length);
  // The Ask badge is the unpaginated backlog total, not the loaded page's length.
  await expect(nav.locator('a[href="/ask"]')).toContainText("12");

  expect(api.unmocked).toEqual([]);
  expect(errors).toEqual([]);
});

test("every section opens from the sidebar and renders without errors", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const api = await mockApi(page);
  await page.goto("/ask");
  await expect(page.getByText(/^Updated /)).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Console sections" });

  for (const entry of SECTION_NAV) {
    await test.step(entry.label, async () => {
      // By href, not name: a link's accessible name also carries its count badge.
      const link = nav.locator(`a[href="${entry.path}"]`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${entry.path}$`));
      await expect(link).toHaveAttribute("aria-current", "page");
      // The section's own content mounted (not just the shared chrome), and the
      // App Router error boundary did not take over.
      await expect(page.locator("main :is(h2, h3)").first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
      // Let the section's own fetches settle before moving on, so an unmocked
      // or failing request is attributed to this step.
      await page.waitForLoadState("networkidle");
      expect(api.unmocked, `unmocked requests on ${entry.path}`).toEqual([]);
      expect(errors, `console errors on ${entry.path}`).toEqual([]);
    });
  }
});

test("a deep link survives a reload with the right section active", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await mockApi(page, {
    "GET /jobs": () => ({ jobs: [jobFixture({ id: "job-1", type: "publish_proposal", state: "completed" })], total: 1 })
  });

  await page.goto("/jobs");
  await page.reload();

  const nav = page.getByRole("navigation", { name: "Console sections" });
  await expect(nav.locator('a[href="/jobs"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Jobs" }).getByRole("button")).toHaveCount(1);
  // With nothing selected the newest job fills the detail pane.
  await expect(page.getByRole("heading", { name: "Publish Proposal", level: 3 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("asking a question shows it queued, then the answer once the watcher finishes", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const state: { jobs: JobView[]; questions: QuestionLog[] } = { jobs: [], questions: [] };
  const api = await mockApi(page, {
    "GET /jobs": () => ({ jobs: state.jobs, total: state.jobs.length }),
    "GET /questions": () => ({
      questions: state.questions,
      total: state.questions.length,
      matching: state.questions.length
    }),
    "POST /ask": () => {
      state.jobs = [jobFixture({ id: "job-9", state: "active" })];
      state.questions = [
        questionFixture({ id: "question-9", question: "How do refunds work?", confidence: "unknown" })
      ];
      return { questionId: "question-9", job: jobFixture({ id: "job-9", state: "created" }) };
    },
    // The bounded wait returns the still-active job when the watcher is slow.
    "GET /jobs/job-9/wait": () => ({ job: jobFixture({ id: "job-9", state: "active" }) })
  });
  await page.goto("/ask");

  const askButton = page.getByRole("button", { name: "Ask", exact: true });
  await expect(askButton).toBeDisabled();
  await page.getByLabel("Question").fill("How do refunds work?");
  await page.getByLabel("Flow").selectOption({ label: "Billing" });
  await askButton.click();

  await expect(page.getByText("Queued as answer_question (active)")).toBeVisible();
  await expect(page.getByText("Answer Question queued. We will update this page when it finishes.")).toBeVisible();
  await expect(page.getByLabel("Question")).toHaveValue("");
  expect(api.calls("POST", "/ask").map((request) => request.body)).toEqual([
    { question: "How do refunds work?", flow: "billing" }
  ]);

  // The watcher completes the job; the console's 4s active-job poll picks it up.
  state.jobs = [jobFixture({ id: "job-9", state: "completed" })];
  state.questions = [
    questionFixture({
      id: "question-9",
      question: "How do refunds work?",
      flowId: "billing",
      answer: { answer: "Refunds settle within five days.", confidence: "high", citations: [] }
    })
  ];

  await expect(page.getByText("Refunds settle within five days.").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Queued as answer_question (active)")).toHaveCount(0);
  await expect(page.getByText("Answer Question completed.")).toBeVisible();
  expect(api.unmocked).toEqual([]);
  expect(errors).toEqual([]);
});

test("an API outage is reported in a toast instead of a blank page", async ({ page }) => {
  await mockApi(page, {
    "GET /health": () => {
      throw new MockApiError(503, "API is down for maintenance");
    }
  });

  await page.goto("/ask");

  await expect(page.getByText("API is down for maintenance")).toBeVisible();
  // The shell and the section still render; only the data is missing.
  await expect(page.getByRole("heading", { name: "Ask a Question" })).toBeVisible();
  await expect(page.getByText("Not refreshed yet")).toBeVisible();
});
