import dagre from "@dagrejs/dagre";
import type { FlowEdgeDef, FlowGraph, FlowNodeKind } from "./types";

// A pure, deterministic layout pass: it turns an authored FlowGraph into
// absolute node/group rectangles using dagre. No DOM is touched, so it runs
// under node:test exactly like the rest of the web package; React Flow consumes
// the output to render. Node sizes are estimated from the label text because we
// have no measured DOM at layout time — the estimate only needs to be close
// enough for dagre to space nodes sensibly.

interface PositionedNode {
  id: string;
  label: string;
  kind: FlowNodeKind;
  group?: string;
  // x/y are top-left corners (React Flow's coordinate convention); dagre works
  // in centres, so we convert below.
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionedGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  groups: PositionedGroup[];
  edges: FlowEdgeDef[];
  width: number;
  height: number;
}

const NODE_MIN_WIDTH = 150;
const CHAR_WIDTH = 7.2;
const NODE_PADDING_X = 30;
const LINE_HEIGHT = 18;
const NODE_PADDING_Y = 28;
const GROUP_PADDING = 26;
const GROUP_LABEL_SPACE = 22;

function estimateSize(label: string): { width: number; height: number } {
  const lines = label.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const width = Math.max(NODE_MIN_WIDTH, Math.round(longest * CHAR_WIDTH) + NODE_PADDING_X);
  const height = lines.length * LINE_HEIGHT + NODE_PADDING_Y;
  return { width, height };
}

export function layoutGraph(graph: FlowGraph): LayoutResult {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({
    rankdir: graph.direction ?? "TB",
    nodesep: 48,
    ranksep: 64,
    marginx: 20,
    marginy: 20
  });
  g.setDefaultEdgeLabel(() => ({}));

  const groups = graph.groups ?? [];
  // Register each group as a compound parent so dagre keeps its members
  // contiguous and reserves whitespace around the cluster.
  for (const group of groups) {
    g.setNode(group.id, { label: group.label });
  }

  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) {
    const size = estimateSize(node.label);
    sizes.set(node.id, size);
    g.setNode(node.id, { width: size.width, height: size.height });
    if (node.group) {
      g.setParent(node.id, node.group);
    }
  }

  for (const edge of graph.edges) {
    g.setEdge(edge.from, edge.to);
  }

  dagre.layout(g);

  const nodes: PositionedNode[] = graph.nodes.map((node) => {
    const laid = g.node(node.id);
    const size = sizes.get(node.id)!;
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      group: node.group,
      x: laid.x - size.width / 2,
      y: laid.y - size.height / 2,
      width: size.width,
      height: size.height
    };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Compute each group rectangle from the bounds of its members rather than
  // trusting dagre's cluster dimensions, so the box always fully encloses them.
  // Extra top/left padding leaves room for the group's label banner.
  const positionedGroups: PositionedGroup[] = groups.map((group) => {
    const members = graph.nodes
      .filter((node) => node.group === group.id)
      .map((node) => byId.get(node.id)!);
    const left = Math.min(...members.map((member) => member.x));
    const top = Math.min(...members.map((member) => member.y));
    const right = Math.max(...members.map((member) => member.x + member.width));
    const bottom = Math.max(...members.map((member) => member.y + member.height));
    return {
      id: group.id,
      label: group.label,
      x: left - GROUP_PADDING,
      y: top - GROUP_PADDING - GROUP_LABEL_SPACE,
      width: right - left + GROUP_PADDING * 2,
      height: bottom - top + GROUP_PADDING * 2 + GROUP_LABEL_SPACE
    };
  });

  const graphLabel = g.graph();
  return {
    nodes,
    groups: positionedGroups,
    edges: graph.edges,
    width: graphLabel.width ?? 0,
    height: graphLabel.height ?? 0
  };
}
