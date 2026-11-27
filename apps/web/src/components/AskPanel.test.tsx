import assert from "node:assert/strict";
import test from "node:test";
import { act, type ComponentProps } from "react";
import type { AnswerTrace, QuestionLog } from "../lib/types";
import { buttonByText, buttonsByText, changeValue, click, renderDom } from "../test/dom";
import { citationFixture, jobFixture, questionFixture } from "../test/fixtures";
import { renderMarkup } from "../test/render";
import { AskPanel } from "./AskPanel";

type Props = ComponentProps<typeof AskPanel>;

interface Calls {
  feedback: Array<[string, string]>;
  gapToggles: Array<[string, boolean]>;
  deletes: Array<[string, boolean]>;
  pages: number[];
  reAsks: Array<[string, string]>;
  searches: string[];
  askFlows: string[];
  questionEdits: string[];
  citationToggles: string[];
  submits: number;
}

function setup(overrides: Partial<Props> = {}, deleteSucceeds = true) {
  const calls: Calls = {
    feedback: [],
    gapToggles: [],
    deletes: [],
    pages: [],
    reAsks: [],
    searches: [],
    askFlows: [],
    questionEdits: [],
    citationToggles: [],
    submits: 0
  };
  const props: Props = {
    answer: undefined,
    answeredSearch: "",
    askFlow: "auto",
    expandedQuestionIds: [],
    flowLabels: { billing: "Billing" },
    flows: [{ id: "billing", name: "Billing" }],
    loading: false,
    onAsk: async (event) => {
      event.preventDefault();
      calls.submits += 1;
    },
    onDelete: async (questionId, scrub) => {
      calls.deletes.push([questionId, scrub]);
      return deleteSucceeds;
    },
    onFeedback: async (questionId, feedback) => {
      calls.feedback.push([questionId, feedback]);
    },
    onPageChange: async (page) => {
      calls.pages.push(page);
    },
    onReAsk: async (question, flow) => {
      calls.reAsks.push([question, flow]);
    },
    onToggleGap: async (questionId, flagged) => {
      calls.gapToggles.push([questionId, flagged]);
    },
    question: "",
    questions: [],
    questionsMatching: 0,
    questionsPage: 0,
    questionsPageCount: 1,
    setAnsweredSearch: (value) => {
      calls.searches.push(value);
    },
    setAskFlow: (value) => {
      calls.askFlows.push(value);
    },
    setQuestion: (value) => {
      calls.questionEdits.push(value);
    },
    toggleCitations: (questionId) => {
      calls.citationToggles.push(questionId);
    },
    ...overrides
  };
  return { calls, props };
}

function markup(overrides: Partial<Props> = {}): string {
  return renderMarkup(<AskPanel {...setup(overrides).props} />);
}

async function mount(t: { after: (fn: () => void) => void }, overrides: Partial<Props> = {}, deleteSucceeds = true) {
  const { calls, props } = setup(overrides, deleteSucceeds);
  const mounted = await renderDom(<AskPanel {...props} />);
  t.after(() => mounted.unmount());
  return { ...mounted, calls, props };
}

function trace(overrides: Partial<AnswerTrace> = {}): AnswerTrace {
  return {
    routing: { mode: "requested" },
    seedSectionCount: 4,
    searches: [],
    poolSectionCount: 4,
    answerForced: false,
    verification: { status: "grounded" },
    ...overrides
  };
}

// --- the ask form -----------------------------------------------------------

test("Ask is disabled until there is a non-blank question, and while a request is in flight", () => {
  const submit = (html: string) => /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";

  assert.match(submit(markup({ question: "" })), /disabled/);
  assert.match(submit(markup({ question: "   " })), /disabled/);
  assert.doesNotMatch(submit(markup({ question: "How?" })), /disabled/);
  assert.match(submit(markup({ question: "How?", loading: true })), /disabled/);
});

test("the flow picker is offered only when flows are configured, with Auto first", () => {
  assert.doesNotMatch(markup({ flows: [] }), /Auto \(let Magpie decide\)/);

  const html = markup();
  assert.ok(html.indexOf("Auto (let Magpie decide)") < html.indexOf(">Billing</option>"));
});

test("typing, picking a flow, searching and submitting are reported to the provider", async (t) => {
  const { container, calls } = await mount(t, { question: "How?" });
  const textarea = container.querySelector("textarea");
  const flowSelect = container.querySelector("select");
  const search = container.querySelector<HTMLInputElement>('input[type="search"]');
  assert.ok(textarea && flowSelect && search);

  await changeValue(textarea, "How do refunds work?");
  await changeValue(flowSelect, "billing");
  await changeValue(search, "refund");
  await click(buttonByText(container, "Ask"));

  assert.deepEqual(calls.questionEdits, ["How do refunds work?"]);
  assert.deepEqual(calls.askFlows, ["billing"]);
  assert.deepEqual(calls.searches, ["refund"]);
  assert.equal(calls.submits, 1);
});

// --- the live answer block --------------------------------------------------

test("a freshly asked question shows as queued until the log carries its answer", () => {
  const answer = { questionId: "question-9", job: jobFixture({ id: "job-9", state: "active" }) };

  const html = markup({ answer, questions: [questionFixture({ id: "question-9", confidence: "unknown" })] });

  assert.match(html, /title="Answer is queued"/);
  assert.match(html, /Queued as answer_question \(active\)/);
});

test("a terminal job without an answer shows the job state instead of pretending to be queued", () => {
  const answer = { questionId: "question-9", job: jobFixture({ id: "job-9", state: "failed" }) };

  const html = markup({ answer });

  assert.match(html, /Queued as answer_question \(failed\)/);
  assert.match(html, /title="Answer is queued"[^>]*>(?:<[^>]+>)*failed/);
});

test("once the question log has the answer, the block shows it with confidence, flow, citations and trace", () => {
  const answer = { questionId: "question-9", job: jobFixture({ id: "job-9", state: "completed" }) };
  const logged = questionFixture({
    id: "question-9",
    flowId: "billing",
    answer: {
      answer: "Refunds settle within five days.",
      confidence: "medium",
      citations: [citationFixture({ heading: "Refund timing", relevance: 0.826 })],
      trace: trace()
    }
  });

  const html = markup({ answer, questions: [logged] });

  assert.doesNotMatch(html, /Queued as/);
  assert.match(html, /title="Answer confidence: medium"/);
  assert.match(html, /title="Knowledge flow: Billing"/);
  assert.match(html, /Refunds settle within five days\./);
  assert.match(html, /Refund timing/);
  // Relevance is a rounded percentage.
  assert.match(html, />83%</);
  assert.match(html, /How this was answered/);
});

// --- answered-question rows -------------------------------------------------

test("a row with no answer yet says so, and a row with no citations gets a 0 badge instead of a toggle", () => {
  const html = markup({ questions: [questionFixture({ confidence: "unknown" })] });

  assert.match(html, /Waiting for an answer\./);
  assert.match(html, /0 citations/);
  assert.doesNotMatch(html, /Show 0 citations/);
});

test("citations stay collapsed until the row is expanded", async (t) => {
  const answered = questionFixture({
    answer: {
      answer: "Yes.",
      confidence: "high",
      citations: [citationFixture(), citationFixture({ sectionId: "kb:b.md#b", heading: "Second" })]
    }
  });
  const { container, calls, props, rerender } = await mount(t, { questions: [answered] });
  assert.doesNotMatch(container.textContent ?? "", /Laboured breathing/);

  await click(buttonByText(container, "Show 2 citations"));
  assert.deepEqual(calls.citationToggles, ["question-1"]);

  await rerender(<AskPanel {...props} expandedQuestionIds={["question-1"]} />);
  assert.match(container.textContent ?? "", /Laboured breathing/);
  assert.equal(buttonsByText(container, "Hide 2 citations").length, 1);
});

test("feedback and gap chips reflect the logged state and send the opposite gap flag", async (t) => {
  const questions = [
    questionFixture({ id: "q-a", feedback: "unhelpful", manualGap: true }),
    questionFixture({ id: "q-b" })
  ];
  const { container, calls } = await mount(t, { questions });
  const pressed = (label: string) => buttonsByText(container, label).map((chip) => chip.getAttribute("aria-pressed"));

  assert.deepEqual(pressed("Helpful"), ["false", "false"]);
  assert.deepEqual(pressed("Unhelpful"), ["true", "false"]);
  assert.deepEqual(pressed("Knowledge gap"), ["true", "false"]);

  await click(buttonsByText(container, "Helpful")[1]);
  await click(buttonsByText(container, "Knowledge gap")[0]);
  await click(buttonsByText(container, "Knowledge gap")[1]);

  assert.deepEqual(calls.feedback, [["q-b", "helpful"]]);
  assert.deepEqual(calls.gapToggles, [
    ["q-a", false],
    ["q-b", true]
  ]);
});

test("an un-routed answer offers its candidate flows and re-asks the original question pinned to the pick", async (t) => {
  const unrouted = questionFixture({
    question: "How long do refunds take?",
    confidence: "unknown",
    answer: {
      answer: "",
      confidence: "unknown",
      citations: [],
      flowSelectionRequired: {
        availableFlows: [
          { id: "billing", name: "Billing" },
          { id: "support", name: "Support" }
        ]
      }
    }
  });
  const { container, calls } = await mount(t, { questions: [unrouted] });

  assert.match(container.textContent ?? "", /Pick a flow to answer this question:/);
  await click(buttonByText(container, "Support"));

  assert.deepEqual(calls.reAsks, [["How long do refunds take?", "support"]]);
});

test("off-topic answers and detected gaps are called out on the row", () => {
  const html = markup({
    questions: [
      questionFixture({
        id: "q-off",
        answer: { answer: "", confidence: "unknown", citations: [], outOfScope: { reason: "Not about billing." } }
      }),
      questionFixture({
        id: "q-gap",
        answer: {
          answer: "Partly.",
          confidence: "low",
          citations: [],
          gaps: ["No doc covers chargebacks", "No doc covers disputes"].map((summary) => ({
            summary,
            question: "What about chargebacks and disputes?",
            confidence: "low" as const,
            citedSectionIds: [],
            source: "followup" as const
          }))
        }
      })
    ]
  });

  assert.match(html, /Off-topic for this flow — no knowledge gap raised\./);
  assert.match(html, /<li>No doc covers chargebacks<\/li><li>No doc covers disputes<\/li>/);
});

// --- the answer trace -------------------------------------------------------

function traceMarkup(value: AnswerTrace): string {
  return markup({
    questions: [questionFixture({ answer: { answer: "A.", confidence: "high", citations: [], trace: value } })]
  });
}

test("the trace explains routing, empty searches and a forced answer", () => {
  const html = traceMarkup(
    trace({
      routing: { mode: "routed", confidence: "medium", method: "embedding" },
      seedSectionCount: 3,
      poolSectionCount: 9,
      answerForced: true,
      answerContract: "unstructured",
      searches: [
        { query: "refund window", resultCount: 2, round: 1 },
        { query: "chargeback fee", resultCount: 0, round: 1 }
      ]
    })
  );

  assert.match(html, /\(medium confidence\)/);
  assert.match(html, /3 seed section\(s\), 9 in the final pool — search budget exhausted, final answer forced/);
  assert.match(html, /Follow-up searches \(2, 1 empty\)/);
  assert.match(html, /“refund window” → 2 section\(s\)/);
  assert.match(html, /“chargeback fee” → nothing found \(grounds a followup gap\)/);
  assert.match(html, /model reply did not parse — shipped as raw text at low confidence/);
});

test("the trace says when no follow-up search ran, and words each verification outcome", () => {
  assert.match(traceMarkup(trace()), /Follow-up searches: none requested/);
  assert.match(traceMarkup(trace()), /ran — every claim supported by the retrieved context/);

  const stripped = traceMarkup(
    trace({
      verification: { status: "claims_stripped", unsupportedClaims: ["Refunds are instant", "Fees are waived"] }
    })
  );
  assert.match(stripped, /2 unsupported claim\(s\) stripped, confidence downgraded/);
  assert.match(stripped, /<li>Refunds are instant<\/li><li>Fees are waived<\/li>/);

  assert.match(
    traceMarkup(trace({ verification: { status: "verdict_unparseable" } })),
    /verifier reply was unusable, drafted answer kept \(fail open\)/
  );
  assert.match(
    traceMarkup(trace({ verification: { status: "skipped", skipReason: "no_sections" } })),
    /skipped — nothing was retrieved to verify against/
  );
  // A skip with no recorded reason must not render a dangling dash.
  assert.match(traceMarkup(trace({ verification: { status: "skipped" } })), /Grounding verification: skipped<\/li>/);
});

// --- empty states and pager -------------------------------------------------

test("the empty list distinguishes 'nothing logged' from 'nothing matches the search'", () => {
  assert.match(markup(), /No questions logged yet\./);

  const searching = markup({ answeredSearch: "refund", questionsMatching: 0 });
  assert.match(searching, /No questions match your search\./);
  assert.match(searching, /0 matches across the whole history/);
  assert.match(markup({ answeredSearch: "refund", questionsMatching: 1 }), /1 match across the whole history/);
});

test("the pager walks pages, disables at both ends and labels matches while searching", async (t) => {
  const base = { questions: [questionFixture()], questionsMatching: 17, questionsPageCount: 3 };
  const { container, calls, props, rerender } = await mount(t, { ...base, questionsPage: 0 });
  const newer = () => buttonByText(container, "← Newer");
  const older = () => buttonByText(container, "Older →");

  assert.match(container.textContent ?? "", /Page 1 of 3 · 17 questions/);
  assert.equal(newer().disabled, true);
  await click(older());

  await rerender(<AskPanel {...props} questionsPage={2} answeredSearch="refund" questionsMatching={1} />);
  assert.match(container.textContent ?? "", /Page 3 of 3 · 1 match(?!es)/);
  assert.equal(older().disabled, true);
  await click(newer());

  assert.deepEqual(calls.pages, [1, 1]);
});

// --- delete dialog ----------------------------------------------------------

test("Delete opens a confirm that can plain-delete or full-scrub, and closes when the delete succeeds", async (t) => {
  const questions: QuestionLog[] = [questionFixture({ id: "q-secret", question: "My password is hunter2?" })];
  const { container, calls } = await mount(t, { questions });
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await click(buttonByText(container, "Delete"));
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog?.textContent ?? "", /My password is hunter2\?/);

  await click(buttonByText(container, "Full scrub"));
  assert.deepEqual(calls.deletes, [["q-secret", true]]);
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await click(buttonByText(container, "Delete"));
  await click(buttonByText(container, "Delete question"));
  assert.deepEqual(calls.deletes[1], ["q-secret", false]);
});

test("a refused delete keeps the confirm open so the operator can retry or cancel", async (t) => {
  const { container, calls } = await mount(t, { questions: [questionFixture()] }, false);

  await click(buttonByText(container, "Delete"));
  await click(buttonByText(container, "Delete question"));

  assert.equal(calls.deletes.length, 1);
  assert.ok(container.querySelector('[role="dialog"]'));
  // The buttons re-enable once the failed attempt settles.
  assert.equal(buttonByText(container, "Delete question").disabled, false);

  await click(buttonByText(container, "Cancel"));
  assert.equal(container.querySelector('[role="dialog"]'), null);
});

test("Escape dismisses the delete confirm without deleting", async (t) => {
  const { container, calls } = await mount(t, { questions: [questionFixture()] });
  await click(buttonByText(container, "Delete"));

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.deepEqual(calls.deletes, []);
});
