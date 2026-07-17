import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionnaireSummary } from "@magpie/core";
import { renderMarkup } from "../test/render";
import { click, renderDom } from "../test/dom";
import { QuestionnaireCreateList } from "./QuestionnaireCreateList";

const FLOWS = [{ id: "security", name: "Security" }];

function summary(): QuestionnaireSummary {
  return {
    id: "qn-1",
    name: "Acme SIG Q3",
    flowId: "security",
    status: "open",
    createdAt: "2026-07-16T00:00:00.000Z",
    counts: { total: 3, reused: 1, answered: 1, pending: 0, unanswerable: 1, approved: 0 }
  };
}

function noopHandlers() {
  return {
    onList: async () => [] as QuestionnaireSummary[],
    onCreate: async () => undefined,
    onOpen: () => {}
  };
}

// Note: the create-submit → navigate flow isn't unit-tested here because this
// test harness (happy-dom + React 19) does not fire onChange for text
// input/textarea — only for <select> — so name/questions state can't be driven.
// That flow is verified end-to-end in the running app instead.

test("renders the create form and the empty state", () => {
  const html = renderMarkup(<QuestionnaireCreateList flows={FLOWS} loading={false} {...noopHandlers()} />);
  assert.match(html, /Create questionnaire/);
  assert.match(html, /Questions \(one per line\)/);
  assert.match(html, /No questionnaires yet/);
});

test("loads summaries on mount and opens one on row click", async () => {
  const opened: string[] = [];
  const handlers = {
    ...noopHandlers(),
    onList: async () => [summary()],
    onOpen: (id: string) => opened.push(id)
  };
  const { container, unmount } = await renderDom(
    <QuestionnaireCreateList flows={FLOWS} loading={false} {...handlers} />
  );
  try {
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme SIG Q3"));
    assert.ok(row, "summary row renders after mount");
    assert.match(row.textContent ?? "", /1 reused \/ 3 total/);
    await click(row);
    assert.deepEqual(opened, ["qn-1"]);
  } finally {
    unmount();
  }
});
