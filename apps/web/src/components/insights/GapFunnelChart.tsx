"use client";

import { useMemo } from "react";
import styled from "@emotion/styled";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes
} from "@xyflow/react";
import type { FunnelStage } from "../../lib/types";

// C1 — Gap-to-merge funnel. A horizontal (left-to-right) React Flow graph of the
// seven pipeline stages, each a node showing its count and the drop-off from the
// first non-zero stage. Styling mirrors the existing DataFlowPanel nodes so the
// funnel reads as part of the same graph family. Layout is a plain deterministic
// left-to-right walk (no dagre needed for a single chain), which keeps it
// SSR-safe for the render tests.

const NODE_WIDTH = 168;
const NODE_HEIGHT = 92;
const NODE_GAP = 64;
const CANVAS_PADDING = 32;

// Edge/arrow stroke, matching the muted DataFlowPanel palette.
const EDGE_STROKE = "#5b6962";

interface FunnelNodeData extends Record<string, unknown> {
  label: string;
  count: number;
  // Percentage retained relative to the first non-zero stage; undefined for that
  // baseline stage (and when there is no baseline, i.e. everything is zero).
  retained?: number;
}

const Card = styled.div(({ theme }) => ({
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "2px",
  padding: `${theme.space.sm} ${theme.space.md}`,
  borderRadius: theme.radius.md,
  border: `1.5px solid ${theme.color.borderStrong}`,
  background: "#e8f1f7",
  borderColor: "#4a7c93",
  boxShadow: theme.shadow.card,
  color: theme.color.text,
  textAlign: "center"
}));

const Count = styled.div(({ theme }) => ({
  fontSize: theme.font.size.xl,
  fontWeight: theme.font.weight.semibold,
  lineHeight: 1.1
}));

const Label = styled.div(({ theme }) => ({
  fontSize: theme.font.size.xs,
  color: theme.color.textMuted
}));

const Retained = styled.div(({ theme }) => ({
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.semibold,
  color: theme.color.textSubtle
}));

// Handle is a React Flow component, so filter transient props before the DOM.
const NodeHandle = styled(Handle, {
  shouldForwardProp: (prop) => !prop.startsWith("$")
})(({ theme }) => ({
  width: "6px",
  height: "6px",
  background: theme.color.textSubtle,
  border: "none"
}));

function FunnelNode({ data }: NodeProps) {
  const { label, count, retained } = data as FunnelNodeData;
  return (
    <Card>
      <NodeHandle type="target" position={Position.Left} />
      <Count>{count}</Count>
      <Label>{label}</Label>
      {retained !== undefined ? <Retained>{retained}% retained</Retained> : null}
      <NodeHandle type="source" position={Position.Right} />
    </Card>
  );
}

const nodeTypes: NodeTypes = { funnelStage: FunnelNode };

const Canvas = styled.div(({ theme }) => ({
  height: 220,
  background: "linear-gradient(135deg, #fafbf9 0%, #f5f7f2 100%)",
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  overflow: "hidden"
}));

// Gap-to-merge funnel graph. Renders even for empty/all-zero data (the ChartCard
// gates on emptiness upstream, but the component stays render-safe on its own).
export function GapFunnelChart({ stages }: { stages: FunnelStage[] }) {
  const { nodes, edges } = useMemo(() => {
    // Baseline is the first stage with a non-zero count, so drop-off is measured
    // from where the pipeline actually starts rather than always from stage 0.
    const baseline = stages.find((stage) => stage.count > 0)?.count;

    const flowNodes: Node[] = stages.map((stage, index) => ({
      id: stage.key,
      type: "funnelStage",
      position: { x: CANVAS_PADDING + index * (NODE_WIDTH + NODE_GAP), y: CANVAS_PADDING },
      data: {
        label: stage.label,
        count: stage.count,
        retained: baseline ? Math.round((stage.count / baseline) * 100) : undefined
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: false,
      selectable: false
    }));

    const flowEdges: Edge[] = stages.slice(1).map((stage, index) => ({
      id: `edge-${stages[index].key}-${stage.key}`,
      source: stages[index].key,
      target: stage.key,
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_STROKE, width: 16, height: 16 },
      style: { stroke: EDGE_STROKE, strokeWidth: 1.6 }
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [stages]);

  return (
    <Canvas>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} color="#e2e7df" />
      </ReactFlow>
    </Canvas>
  );
}
