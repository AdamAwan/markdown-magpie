import assert from "node:assert/strict";
import test from "node:test";
import type { Questionnaire, QuestionnaireSummary } from "@magpie/core";
import { renderMarkup } from "../test/render";
import { click, renderDom } from "../test/dom";
import { QuestionnairesPanel } from "./QuestionnairesPanel";

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

function worksheet(): Questionnaire {
  return {
    id: "qn-1",
    name: "Acme SIG Q3",
    flowId: "security",
    status: "open",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [
      {
        id: "i-0",
        questionnaireId: "qn-1",
        position: 0,
        question: "What certs do you hold?",
        status: "answered",
        outcome: "reused",
        answer: "ISO 27001 and SOC 2.",
        answeredAt: "2026-04-12T09:00:00.000Z",
        staleAtApproval: false,
        citations: [{ sectionId: "s-1", contentHash: "h", path: "certs.md", heading: "Certificates", excerpt: "…" }]
      },
      {
        id: "i-1",
        questionnaireId: "qn-1",
        position: 1,
        question: "Where is data stored?",
        status: "answered",
        outcome: "changed",
        answer: "EU-west, with backups in EU-central.",
        answeredAt: "2026-07-16T10:00:00.000Z",
        changeReason: {
          kind: "section_changed",
          sectionId: "s-2",
          path: "data.md",
          heading: "Data residency",
          changedAt: "2026-06-03T00:00:00.000Z"
        },
        staleAtApproval: false,
        citations: []
      },
      {
        id: "i-2",
        questionnaireId: "qn-1",
        position: 2,
        question: "Do you hold FedRAMP?",
        status: "unanswerable",
        outcome: "fresh",
        staleAtApproval: false,
        citations: []
      }
    ]
  };
}

function noopHandlers() {
  return {
    onList: async () => [] as QuestionnaireSummary[],
    onGet: async () => undefined,
    onCreate: async () => undefined,
    onApproveItem: async () => false,
    onApproveReused: async () => undefined,
    onExport: async (_id: string, _format: "md" | "csv") => {}
  };
}

test("renders the create form and the empty state", () => {
  const html = renderMarkup(<QuestionnairesPanel flows={FLOWS} loading={false} {...noopHandlers()} />);
  assert.match(html, /Create questionnaire/);
  assert.match(html, /Questions \(one per line\)/);
  assert.match(html, /No questionnaires yet/);
});

test("loads summaries on mount and opens a worksheet with per-item badges and change reasons", async () => {
  const handlers = {
    ...noopHandlers(),
    onList: async () => [summary()],
    onGet: async () => worksheet()
  };
  const { container, unmount } = await renderDom(<QuestionnairesPanel flows={FLOWS} loading={false} {...handlers} />);
  try {
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme SIG Q3"));
    assert.ok(row, "summary row renders after mount");
    assert.match(row.textContent ?? "", /1 reused \/ 3 total/);

    await click(row);
    const text = container.textContent ?? "";
    assert.match(text, /reused/, "reused badge");
    assert.match(text, /ISO 27001 and SOC 2\./);
    assert.match(text, /Re-answered: cited section “Data residency” changed on 2026-06-03\./);
    assert.match(text, /unanswerable/);
    assert.match(text, /logged as a knowledge gap/);
    assert.match(text, /certs\.md — Certificates/, "citations render");
    assert.match(text, /Approve all reused/);
    assert.match(text, /Export \.md/);
  } finally {
    unmount();
  }
});

test("export buttons call through with the questionnaire id and format", async () => {
  const exports: Array<[string, string]> = [];
  const handlers = {
    ...noopHandlers(),
    onList: async () => [summary()],
    onGet: async () => worksheet(),
    onExport: async (id: string, format: "md" | "csv") => {
      exports.push([id, format]);
    }
  };
  const { container, unmount } = await renderDom(<QuestionnairesPanel flows={FLOWS} loading={false} {...handlers} />);
  try {
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme SIG Q3"));
    assert.ok(row);
    await click(row);
    const exportButtons = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.startsWith("Export .")
    );
    assert.equal(exportButtons.length, 2, "both export buttons render");
    await click(exportButtons[0]);
    await click(exportButtons[1]);
    assert.deepEqual(exports, [
      ["qn-1", "md"],
      ["qn-1", "csv"]
    ]);
  } finally {
    unmount();
  }
});

test("approving an answered item calls through and refreshes the worksheet", async () => {
  const approvals: string[] = [];
  const handlers = {
    ...noopHandlers(),
    onList: async () => [summary()],
    onGet: async () => worksheet(),
    onApproveItem: async (_questionnaireId: string, itemId: string) => {
      approvals.push(itemId);
      return true;
    }
  };
  const { container, unmount } = await renderDom(<QuestionnairesPanel flows={FLOWS} loading={false} {...handlers} />);
  try {
    const row = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme SIG Q3"));
    assert.ok(row);
    await click(row);
    const approveButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Approve"
    );
    assert.equal(approveButtons.length, 2, "both answered items are approvable");
    await click(approveButtons[0]);
    assert.deepEqual(approvals, ["i-0"]);
  } finally {
    unmount();
  }
});
