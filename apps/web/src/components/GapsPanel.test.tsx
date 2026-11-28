import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentProps } from "react";
import type { GapCandidate } from "../lib/types";
import { buttonByText, buttonsByText, changeValue, click, renderDom } from "../test/dom";
import { clusterFixture, gapFixture } from "../test/fixtures";
import { renderMarkup } from "../test/render";
import { GapClusterPanel, GapPanel } from "./GapsPanel";

type ClusterProps = ComponentProps<typeof GapClusterPanel>;

const refunds = "How are refunds processed?";
const chargebacks = "What is the chargeback fee?";
const invoices = "Where do I download invoices?";

const clusters = [
  clusterFixture({
    id: "cluster-money",
    title: "Money back",
    summaries: [refunds, chargebacks],
    rationale: "Both are about reversing a payment.",
    flowId: "billing"
  }),
  clusterFixture({ id: "cluster-invoices", title: "Invoices", summaries: [invoices], flowId: "billing" })
];

async function mountClusters(t: { after: (fn: () => void) => void }, overrides: Partial<ClusterProps> = {}) {
  const drafted: Array<[string[], string | undefined]> = [];
  const props: ClusterProps = {
    clusters,
    gaps: [],
    loading: false,
    flowLabels: { billing: "Billing" },
    draftCluster: async (summaries, flowId) => {
      drafted.push([summaries, flowId]);
    },
    ...overrides
  };
  const mounted = await renderDom(<GapClusterPanel {...props} />);
  t.after(() => mounted.unmount());
  return { ...mounted, drafted, props };
}

/** Each cluster card as [title, its gap summaries], read back from the DOM. */
function groups(container: HTMLElement): Array<[string, string[]]> {
  return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Cluster title"]')].map((title) => {
    const card = title.closest("article");
    assert.ok(card, "expected the cluster card around its title input");
    return [title.value, [...card.querySelectorAll("li > span")].map((item) => item.textContent ?? "")];
  });
}

function moveSelectFor(container: HTMLElement, summary: string): HTMLSelectElement {
  const item = [...container.querySelectorAll("li")].find((candidate) => candidate.textContent?.startsWith(summary));
  const select = item?.querySelector("select");
  assert.ok(select, `expected a move select for "${summary}"`);
  return select;
}

test("clusters render the server suggestion with its rationale, and no edited hint", async (t) => {
  const { container } = await mountClusters(t);

  assert.deepEqual(groups(container), [
    ["Money back", [refunds, chargebacks]],
    ["Invoices", [invoices]]
  ]);
  const text = container.textContent ?? "";
  assert.match(text, /Both are about reversing a payment\./);
  assert.match(text, /2 gaps/);
  assert.match(text, /1 gap(?!s)/);
  assert.doesNotMatch(text, /Edited — drafting uses your groupings\./);
});

test("moving a gap regroups it, drops both stale rationales and marks the panel edited", async (t) => {
  const { container, drafted } = await mountClusters(t);
  const move = moveSelectFor(container, chargebacks);
  // A gap can move to any other cluster or a new one — never to the one it is in.
  assert.deepEqual(
    [...move.options].map((option) => option.textContent),
    ["Move to…", "Invoices", "New cluster"]
  );

  await changeValue(move, "cluster-invoices");

  assert.deepEqual(groups(container), [
    ["Money back", [refunds]],
    ["Invoices", [invoices, chargebacks]]
  ]);
  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /Both are about reversing a payment\./);
  assert.match(text, /Edited — drafting uses your groupings\./);

  // Drafting sends the reviewer's grouping, not the original suggestion.
  await click(buttonsByText(container, "Draft Proposal")[1]);
  assert.deepEqual(drafted, [[[invoices, chargebacks], "billing"]]);
});

test("splitting a gap into a new cluster titles it from the gap and keeps the source flow", async (t) => {
  const { container, drafted } = await mountClusters(t);

  await changeValue(moveSelectFor(container, chargebacks), "__new__");

  assert.deepEqual(groups(container), [
    ["Money back", [refunds]],
    ["Invoices", [invoices]],
    ["What is the chargeback fee", [chargebacks]]
  ]);
  await click(buttonsByText(container, "Draft Proposal")[2]);
  assert.deepEqual(drafted, [[[chargebacks], "billing"]]);
});

test("moving the last gap out of a cluster removes the emptied cluster", async (t) => {
  const { container } = await mountClusters(t);

  await changeValue(moveSelectFor(container, invoices), "cluster-money");

  assert.deepEqual(groups(container), [["Money back", [refunds, chargebacks, invoices]]]);
});

test("local edits survive a poll that re-sends the same suggestion, and reset when it really changes", async (t) => {
  const { container, props, rerender } = await mountClusters(t);
  const title = container.querySelector<HTMLInputElement>('input[aria-label="Cluster title"]');
  assert.ok(title);
  await changeValue(title, "Refunds and chargebacks");
  await changeValue(moveSelectFor(container, chargebacks), "__new__");

  // Same content, fresh array identity — what every provider poll hands down.
  await rerender(<GapClusterPanel {...props} clusters={clusters.map((cluster) => ({ ...cluster }))} />);
  assert.equal(groups(container)[0][0], "Refunds and chargebacks");
  assert.equal(groups(container).length, 3);

  // The server regrouped: the reviewer's edits are stale and the new suggestion wins.
  await rerender(<GapClusterPanel {...props} clusters={[clusters[1]]} />);
  assert.deepEqual(groups(container), [["Invoices", [invoices]]]);
  assert.doesNotMatch(container.textContent ?? "", /Edited — drafting uses your groupings\./);
});

test("a cluster's question count de-duplicates question ids within its own flow only", async (t) => {
  const gaps: GapCandidate[] = [
    gapFixture({ summary: refunds, flowId: "billing", questionIds: ["q1", "q2"] }),
    gapFixture({ summary: chargebacks, flowId: "billing", questionIds: ["q2", "q3"] }),
    // Same summary under another flow must not inflate the billing cluster.
    gapFixture({ summary: refunds, flowId: "support", questionIds: ["q7", "q8", "q9"] })
  ];
  const { container } = await mountClusters(t, { gaps });

  const badge = [...container.querySelectorAll("[title]")].find((node) => node.textContent === "2 gaps");
  assert.equal(badge?.getAttribute("title"), "3 question(s) across 2 gap(s)");
});

test("while a draft is in flight the move and draft controls are disabled", async (t) => {
  const { container } = await mountClusters(t, { loading: true });

  assert.ok([...container.querySelectorAll("select")].every((select) => select.disabled));
  assert.ok(buttonsByText(container, "Draft Proposal").every((button) => button.disabled));
});

test("with no clusters the panel says so", () => {
  const html = renderMarkup(
    <GapClusterPanel clusters={[]} gaps={[]} loading={false} flowLabels={{}} draftCluster={async () => undefined} />
  );

  assert.match(html, /No gap clusters yet\./);
});

// --- GapPanel ---------------------------------------------------------------

test("gap candidates list their grouped questions and draft the clicked gap", async (t) => {
  const gaps = [
    gapFixture({ summary: refunds, flowId: "billing", count: 1, questionIds: ["q1"] }),
    // The same summary under a second flow is a distinct candidate.
    gapFixture({ summary: refunds, flowId: "support", count: 3, questionIds: ["q7", "q8", "q9"] })
  ];
  const drafted: GapCandidate[] = [];
  const mounted = await renderDom(
    <GapPanel
      gaps={gaps}
      loading={false}
      flowLabels={{ billing: "Billing" }}
      draftProposal={async (gap) => {
        drafted.push(gap);
      }}
    />
  );
  t.after(() => mounted.unmount());
  const text = mounted.container.textContent ?? "";

  assert.match(text, /1 question(?!s)/);
  assert.match(text, /3 questions/);
  assert.match(text, /q7, q8, q9/);
  // A flow with no configured label falls back to its raw id.
  assert.match(text, /support/);

  await click(buttonsByText(mounted.container, "Draft Proposal")[1]);
  assert.deepEqual(drafted, [gaps[1]]);
});

test("the gap list has an empty state and disables drafting while loading", async (t) => {
  assert.match(
    renderMarkup(<GapPanel gaps={[]} loading={false} flowLabels={{}} draftProposal={async () => undefined} />),
    /No gap candidates yet\./
  );

  const mounted = await renderDom(
    <GapPanel gaps={[gapFixture()]} loading flowLabels={{}} draftProposal={async () => undefined} />
  );
  t.after(() => mounted.unmount());
  assert.equal(buttonByText(mounted.container, "Draft Proposal").disabled, true);
});
