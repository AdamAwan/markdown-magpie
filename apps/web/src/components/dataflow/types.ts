// The data model for the interactive data-flow diagrams. Flows are authored as
// plain node/edge data (see flows.ts) and laid out by a pure dagre pass (see
// layout.ts) before React Flow renders them. Keeping this module free of any
// React or @xyflow import is deliberate: the authoring and layout layers stay
// unit-testable under node:test, exactly like the rest of the web package.

// Visual category for a node. The first five mirror the on-screen legend
// (Source / Processing / Storage / AI provider / User-API); `decision` is a
// branch point (the diamond shapes in the old mermaid graphs) and `highlight`
// emphasises a pivotal node such as the reconcile gate.
export type FlowNodeKind =
  | "source"
  | "processing"
  | "storage"
  | "ai"
  | "user"
  | "decision"
  | "highlight";

interface FlowNodeDef {
  id: string;
  // Labels may contain "\n" for line breaks; the renderer and the layout size
  // estimator both split on it.
  label: string;
  kind: FlowNodeKind;
  // id of the containing group (subgraph), if any.
  group?: string;
}

export interface FlowEdgeDef {
  from: string;
  to: string;
  label?: string;
  // dashed renders the dotted "-.->" relationships from the mermaid originals;
  // animated adds React Flow's flowing-dash animation for the primary path.
  dashed?: boolean;
  animated?: boolean;
}

interface FlowGroupDef {
  id: string;
  label: string;
}

export interface FlowGraph {
  direction?: "TB" | "LR";
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  groups?: FlowGroupDef[];
}
