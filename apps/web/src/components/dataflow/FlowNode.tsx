import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowNodeKind } from "./types";

// Custom React Flow nodes. The flow node renders an authored node styled by its
// kind (the colours mirror the on-screen legend); the group node is a passive
// background banner drawn behind its members. Both pull their geometry from the
// dagre layout via the node's `style` width/height, so what dagre spaced out is
// what React Flow paints.

interface FlowNodeData extends Record<string, unknown> {
  label: string;
  kind: FlowNodeKind;
  direction?: "TB" | "LR";
}

interface GroupNodeData extends Record<string, unknown> {
  label: string;
}

export function FlowNode({ data }: NodeProps) {
  const { label, kind, direction } = data as FlowNodeData;
  const lines = label.split("\n");
  const targetPosition = direction === "LR" ? Position.Left : Position.Top;
  const sourcePosition = direction === "LR" ? Position.Right : Position.Bottom;
  return (
    <div className={`dfNode dfNode-${kind}`}>
      <Handle type="target" position={targetPosition} className="dfHandle" />
      <div className="dfNodeLabel">
        {lines.map((line, index) => (
          <span key={index} className={index === 0 ? "dfNodeLine dfNodeLineHead" : "dfNodeLine"}>
            {line}
          </span>
        ))}
      </div>
      <Handle type="source" position={sourcePosition} className="dfHandle" />
    </div>
  );
}

export function GroupNode({ data }: NodeProps) {
  const { label } = data as GroupNodeData;
  return (
    <div className="dfGroup">
      <div className="dfGroupLabel">{label}</div>
    </div>
  );
}
