import assert from "node:assert/strict";
import test from "node:test";
import { layoutGraph } from "./layout";
import type { FlowGraph } from "./types";

const graph: FlowGraph = {
  direction: "TB",
  groups: [{ id: "g1", label: "Group One" }],
  nodes: [
    { id: "a", kind: "source", label: "Alpha" },
    { id: "b", kind: "processing", label: "Beta\ntwo lines", group: "g1" },
    { id: "c", kind: "storage", label: "Gamma", group: "g1" }
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c", label: "next" }
  ]
};

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

test("assigns finite positions and sizes to every node", () => {
  const result = layoutGraph(graph);
  assert.equal(result.nodes.length, 3);
  for (const node of result.nodes) {
    assert.ok(isFiniteNumber(node.x), `${node.id} x`);
    assert.ok(isFiniteNumber(node.y), `${node.id} y`);
    assert.ok(node.width > 0, `${node.id} width`);
    assert.ok(node.height > 0, `${node.id} height`);
  }
  assert.ok(result.width > 0);
  assert.ok(result.height > 0);
});

test("multi-line labels are taller than single-line labels", () => {
  const result = layoutGraph(graph);
  const single = result.nodes.find((node) => node.id === "a")!;
  const multi = result.nodes.find((node) => node.id === "b")!;
  assert.ok(multi.height > single.height, "two-line node should be taller");
});

test("group bounding box encloses its member nodes", () => {
  const result = layoutGraph(graph);
  const group = result.groups.find((candidate) => candidate.id === "g1");
  assert.ok(group, "expected group g1 in the layout");

  const members = result.nodes.filter((node) => node.group === "g1");
  assert.equal(members.length, 2);
  for (const member of members) {
    assert.ok(group!.x <= member.x, `${member.id} left inside group`);
    assert.ok(group!.y <= member.y, `${member.id} top inside group`);
    assert.ok(group!.x + group!.width >= member.x + member.width, `${member.id} right inside group`);
    assert.ok(group!.y + group!.height >= member.y + member.height, `${member.id} bottom inside group`);
  }
});

test("preserves edges referencing laid-out nodes", () => {
  const result = layoutGraph(graph);
  const ids = new Set(result.nodes.map((node) => node.id));
  assert.equal(result.edges.length, 2);
  for (const edge of result.edges) {
    assert.ok(ids.has(edge.from));
    assert.ok(ids.has(edge.to));
  }
});

test("layout is deterministic", () => {
  const first = layoutGraph(graph);
  const second = layoutGraph(graph);
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(first.groups, second.groups);
});
