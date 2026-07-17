import assert from "node:assert/strict";
import test from "node:test";
import type { Questionnaire } from "@magpie/core";
import { click, renderDom } from "../test/dom";
import { QuestionnaireDetail } from "./QuestionnaireDetail";

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
      },
      {
        id: "i-3",
        questionnaireId: "qn-1",
        position: 3,
        question: "Prior approved answer?",
        status: "approved",
        outcome: "reused",
        answer: "Yes.",
        approvedAt: "2026-07-16T11:00:00.000Z",
        staleAtApproval: false,
        citations: []
      }
    ]
  };
}

function noopHandlers() {
  return {
    onGet: async () => worksheet(),
    onApproveItem: async () => false,
    onApproveReused: async () => undefined,
    onExport: async () => {}
  };
}

function props(overrides = {}) {
  return { id: "qn-1", backHref: "/questionnaires", ...noopHandlers(), ...overrides };
}

test("renders the header, back link, items and export/approve controls — but no create form", async () => {
  const { container, unmount } = await renderDom(<QuestionnaireDetail {...props()} />);
  try {
    const text = container.textContent ?? "";
    assert.match(text, /Acme SIG Q3/, "name header");
    assert.match(text, /← Questionnaires/, "back link");
    assert.match(text, /ISO 27001 and SOC 2\./);
    assert.match(text, /Re-answered: cited section “Data residency” changed on 2026-06-03\./);
    assert.match(text, /logged as a knowledge gap/);
    assert.match(text, /certs\.md — Certificates/, "citations render");
    assert.match(text, /Approve all reused/);
    assert.match(text, /Export \.md/);

    const backLink = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Questionnaires"));
    assert.equal(backLink?.getAttribute("href"), "/questionnaires");

    // The create form must NOT be on the detail page.
    assert.doesNotMatch(text, /Create questionnaire/);
    assert.doesNotMatch(text, /Questions \(one per line\)/);
  } finally {
    unmount();
  }
});

test("the stat banner counts item states", async () => {
  const { container, unmount } = await renderDom(<QuestionnaireDetail {...props()} />);
  try {
    // Tiles pair a number with a label; assert each label sits next to its count.
    const tiles = [...container.querySelectorAll("div")]
      .map((el) => el.textContent ?? "")
      .filter((t) => /^\d+(Total|Approved|Awaiting approval|In progress|Unanswerable|Reused)$/.test(t));
    const byLabel = new Map(tiles.map((t) => [t.replace(/^\d+/, ""), Number(t.match(/^\d+/)?.[0])]));
    assert.equal(byLabel.get("Total"), 4);
    assert.equal(byLabel.get("Approved"), 1);
    assert.equal(byLabel.get("Awaiting approval"), 2);
    assert.equal(byLabel.get("In progress"), 0);
    assert.equal(byLabel.get("Unanswerable"), 1);
    assert.equal(byLabel.get("Reused"), 2);
  } finally {
    unmount();
  }
});

test("only answered items are approvable and approve calls through", async () => {
  const approvals: string[] = [];
  const { container, unmount } = await renderDom(
    <QuestionnaireDetail
      {...props({
        onApproveItem: async (_qId: string, itemId: string) => {
          approvals.push(itemId);
          return true;
        }
      })}
    />
  );
  try {
    const approveButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Approve");
    assert.equal(approveButtons.length, 2, "both answered items are approvable");
    await click(approveButtons[0]);
    assert.deepEqual(approvals, ["i-0"]);
  } finally {
    unmount();
  }
});

test("export buttons call the authed export handler with the format", async () => {
  const exports: Array<[string, string]> = [];
  const { container, unmount } = await renderDom(
    <QuestionnaireDetail
      {...props({
        onExport: async (id: string, format: "md" | "csv") => {
          exports.push([id, format]);
        }
      })}
    />
  );
  try {
    const md = [...container.querySelectorAll("button")].find((b) => b.textContent === "Export .md");
    assert.ok(md, "export .md button renders");
    await click(md);
    assert.deepEqual(exports, [["qn-1", "md"]]);
  } finally {
    unmount();
  }
});

test("an unknown id shows a not-found state with the back link", async () => {
  const { container, unmount } = await renderDom(<QuestionnaireDetail {...props({ onGet: async () => undefined })} />);
  try {
    const text = container.textContent ?? "";
    assert.match(text, /Questionnaire not found\./);
    assert.match(text, /← Questionnaires/);
  } finally {
    unmount();
  }
});
