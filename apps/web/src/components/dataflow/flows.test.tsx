import assert from "node:assert/strict";
import test from "node:test";
import { FLOW_GROUPS, FLOWS, buildFlowGraph, type FlowKey } from "./flows";

const modelInfo = {
  chatModel: "claude-opus-4-8",
  chatHost: "Anthropic",
  embeddingModel: "text-embedding-3-large",
  embeddingHost: "OpenAI"
};

const ALL_KEYS: FlowKey[] = [
  "overview",
  "ask",
  "improvement",
  "automation",
  "reconcile",
  "gappr",
  "perflow"
];

const EXPECTED_GROUPS = [
  { title: "Start here", keys: ["overview"] },
  { title: "Common workflows", keys: ["ask", "improvement", "automation"] },
  { title: "Deep dives", keys: ["reconcile", "gappr", "perflow"] }
];
const HORIZONTAL_KEYS: FlowKey[] = ["overview", "ask", "automation", "reconcile", "gappr", "perflow"];

test("exposes every flow with a title and builder", () => {
  assert.deepEqual(
    FLOWS.map((flow) => flow.key),
    ALL_KEYS
  );
  for (const flow of FLOWS) {
    assert.ok(flow.title.length > 0, `${flow.key} needs a title`);
    assert.equal(typeof flow.build, "function");
  }
});

test("groups flows by reader intent", () => {
  assert.deepEqual(
    FLOW_GROUPS.map((group) => ({ title: group.title, keys: group.flows.map((flow) => flow.key) })),
    EXPECTED_GROUPS
  );
  assert.deepEqual(
    FLOW_GROUPS.flatMap((group) => group.flows.map((flow) => flow.key)),
    ALL_KEYS
  );
});

test("uses horizontal layout for linear dataflow diagrams", () => {
  for (const key of HORIZONTAL_KEYS) {
    assert.equal(buildFlowGraph(key, modelInfo).direction, "LR", `${key} should read left-to-right`);
  }
  assert.equal(buildFlowGraph("improvement", modelInfo).direction, "TB", "branch-heavy improvement view stays vertical");
});

test("every edge and group reference resolves to a node in the same flow", () => {
  for (const key of ALL_KEYS) {
    const graph = buildFlowGraph(key, modelInfo);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const groupIds = new Set((graph.groups ?? []).map((group) => group.id));

    for (const edge of graph.edges) {
      assert.ok(nodeIds.has(edge.from), `${key}: edge from unknown node ${edge.from}`);
      assert.ok(nodeIds.has(edge.to), `${key}: edge to unknown node ${edge.to}`);
    }
    for (const node of graph.nodes) {
      if (node.group !== undefined) {
        assert.ok(groupIds.has(node.group), `${key}: node ${node.id} in unknown group ${node.group}`);
      }
    }
  }
});

test("model names are interpolated into labels", () => {
  const ask = buildFlowGraph("ask", modelInfo);
  const serialized = ask.nodes.map((node) => node.label).join("\n");
  assert.match(serialized, /claude-opus-4-8/);
  assert.match(serialized, /text-embedding-3-large/);
});

test("the reconcile gate depicts the post-Scope-B outcome", () => {
  const graph = buildFlowGraph("reconcile", modelInfo);
  const serialized = JSON.stringify(graph);

  // Scope B is done: source-sync is a first-class proposal, so the old
  // asymmetry warning must be gone.
  assert.doesNotMatch(serialized, /scope b/i);
  assert.doesNotMatch(serialized, /can only defer/i);
  assert.doesNotMatch(serialized, /never folds/i);

  // Source-sync now flows into the same gate as the other lenses and can fold.
  const sourceSync = graph.nodes.find((node) => /source[ -]?sync/i.test(node.label));
  assert.ok(sourceSync, "expected a source-sync trigger node");
  const gate = graph.nodes.find((node) => node.kind === "highlight");
  assert.ok(gate, "expected the gate to be a highlighted node");

  // There is a fold outcome reachable from the gate.
  const foldEdge = graph.edges.find((edge) => edge.from === gate!.id && /fold/i.test(edge.label ?? ""));
  assert.ok(foldEdge, "expected a fold edge out of the gate");
});
