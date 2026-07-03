import styled from "@emotion/styled";
import type { CSSObject } from "@emotion/react";
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

// Per-kind fill/border. These bespoke diagram colours mirror the on-screen
// legend and have no token equivalent, so they stay as literals here.
const kindStyles: Record<FlowNodeKind, CSSObject> = {
  source: { background: "#fbfcfa", borderColor: "#285f74" },
  processing: { background: "#e8f1f7", borderColor: "#4a7c93" },
  storage: { background: "#f0f4f0", borderColor: "#3d6b43" },
  ai: { background: "#fef9f0", borderColor: "#8b5a00" },
  user: { background: "#f5f7f2", borderColor: "#b8c0b4" },
  decision: {
    background: "#fffaf0",
    borderColor: "#8b5a00",
    borderStyle: "dashed",
    fontStyle: "italic"
  },
  highlight: {
    background: "#fff3e6",
    borderColor: "#c2541f",
    borderWidth: "2px",
    boxShadow: "0 2px 8px rgba(194, 84, 31, 0.18)",
    fontWeight: 600
  }
};

const NodeCard = styled.div<{ $kind: FlowNodeKind }>(({ theme, $kind }) => ({
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: `${theme.space.md} ${theme.space.lg}`,
  borderRadius: theme.radius.md,
  border: `1.5px solid ${theme.color.borderStrong}`,
  background: theme.color.surface,
  boxShadow: theme.shadow.card,
  fontSize: theme.font.size.sm,
  lineHeight: 1.3,
  color: theme.color.text,
  ...kindStyles[$kind]
}));

const NodeLabel = styled.div({
  display: "flex",
  flexDirection: "column",
  gap: "1px"
});

const NodeLine = styled.span<{ $head: boolean }>(({ theme, $head }) => ({
  fontWeight: $head ? theme.font.weight.semibold : theme.font.weight.regular
}));

// Handle is a React Flow component, so filter transient props before they reach the DOM.
const NodeHandle = styled(Handle, {
  shouldForwardProp: (prop) => !prop.startsWith("$")
})(({ theme }) => ({
  width: "6px",
  height: "6px",
  background: theme.color.textSubtle,
  border: "none"
}));

export function FlowNode({ data }: NodeProps) {
  const { label, kind, direction } = data as FlowNodeData;
  const lines = label.split("\n");
  const targetPosition = direction === "LR" ? Position.Left : Position.Top;
  const sourcePosition = direction === "LR" ? Position.Right : Position.Bottom;
  return (
    <NodeCard $kind={kind}>
      <NodeHandle type="target" position={targetPosition} />
      <NodeLabel>
        {lines.map((line, index) => (
          <NodeLine key={index} $head={index === 0}>
            {line}
          </NodeLine>
        ))}
      </NodeLabel>
      <NodeHandle type="source" position={sourcePosition} />
    </NodeCard>
  );
}

const GroupBanner = styled.div(({ theme }) => ({
  width: "100%",
  height: "100%",
  border: `1.5px dashed ${theme.color.borderStrong}`,
  borderRadius: theme.radius.card,
  background: "rgba(255, 255, 255, 0.35)"
}));

const GroupLabel = styled.div(({ theme }) => ({
  padding: `${theme.space.sm} ${theme.space.lg}`,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: theme.color.textMuted
}));

export function GroupNode({ data }: NodeProps) {
  const { label } = data as GroupNodeData;
  return (
    <GroupBanner>
      <GroupLabel>{label}</GroupLabel>
    </GroupBanner>
  );
}
