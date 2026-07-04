"use client";

import { useEffect, useMemo, useState } from "react";
import styled from "@emotion/styled";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeTypes
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { RuntimeConfig } from "../lib/types";
import { extractModelInfo } from "../lib/config";
import { FLOW_GROUPS, buildFlowGraph, type FlowKey } from "./dataflow/flows";
import { layoutGraph } from "./dataflow/layout";
import { DATAFLOW_FIT_VIEW_OPTIONS, DATAFLOW_MAX_ZOOM, DATAFLOW_MIN_ZOOM } from "./dataflow/viewport";
import { FlowNode, GroupNode } from "./dataflow/FlowNode";
import { Surface } from "./ui";

const nodeTypes: NodeTypes = {
  flowNode: FlowNode,
  flowGroup: GroupNode
};

// Colour the edge + arrowhead by whether it's a primary step or a dotted
// feedback/relationship link, matching the muted palette used elsewhere.
const SOLID_STROKE = "#5b6962";
const DASHED_STROKE = "#9aa69e";

const PanelBody = styled.div(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  gap: theme.space.xxl,
  padding: theme.space.xl
}));

const FlowTabs = styled.div(({ theme }) => ({
  display: "grid",
  gridTemplateColumns: "minmax(160px, 0.75fr) repeat(2, minmax(220px, 1fr))",
  gap: theme.space.lg,
  alignItems: "start",
  borderBottom: `1px solid ${theme.color.border}`,
  paddingBottom: theme.space.lg,
  "@media (max-width: 900px)": {
    gridTemplateColumns: "1fr"
  }
}));

const FlowTabGroup = styled.div(({ theme }) => ({
  display: "grid",
  gap: theme.space.md,
  alignContent: "start"
}));

const FlowTabGroupTitle = styled.div(({ theme }) => ({
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.semibold,
  textTransform: "uppercase"
}));

const FlowTabGroupItems = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.md
}));

const FlowTab = styled.button<{ $active: boolean }>(({ theme, $active }) => ({
  padding: `${theme.space.md} ${theme.space.xl}`,
  background: "transparent",
  border: "none",
  borderBottom: `2px solid ${$active ? theme.color.accent : "transparent"}`,
  color: $active ? theme.color.accent : theme.color.textMuted,
  fontWeight: theme.font.weight.semibold,
  fontSize: theme.font.size.base,
  cursor: "pointer",
  transition: "color 120ms ease, border-color 120ms ease",
  "&:hover": {
    color: theme.color.text
  }
}));

const FlowCanvas = styled.div(({ theme }) => ({
  height: "clamp(560px, 72vh, 720px)",
  background: "linear-gradient(135deg, #fafbf9 0%, #f5f7f2 100%)",
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  overflow: "hidden"
}));

const FlowLegend = styled.div(({ theme }) => ({
  background: theme.color.surfaceMuted,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.sm,
  padding: theme.space.xxl,
  "& h3": {
    marginBottom: theme.space.xl,
    color: theme.color.text,
    fontSize: theme.font.size.lg
  }
}));

const LegendItems = styled.div(({ theme }) => ({
  display: "flex",
  flexWrap: "wrap",
  gap: theme.space.xxl
}));

const LegendItem = styled.div(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space.lg,
  fontSize: theme.font.size.md,
  color: theme.color.textMuted
}));

const LegendBox = styled.span({
  width: "24px",
  height: "24px",
  borderRadius: "4px",
  flexShrink: 0
});

export function DataFlowPanel({ config }: { config?: RuntimeConfig }) {
  const [activeFlow, setActiveFlow] = useState<FlowKey>("overview");
  const modelInfo = useMemo(() => extractModelInfo(config), [config]);

  const built = useMemo(() => {
    const graph = buildFlowGraph(activeFlow, modelInfo);
    const direction = graph.direction ?? "TB";
    const layout = layoutGraph(graph);

    // Provide width/height as top-level node fields (not just style) so React
    // Flow treats the nodes as already measured. That makes nodesInitialized
    // true synchronously; fitView frames the graph and edges resolve their
    // endpoints without depending on the per-node ResizeObserver, which is
    // unreliable under Next dev's React 19 StrictMode double-mount.
    const groupNodes: Node[] = layout.groups.map((group) => ({
      id: `group-${group.id}`,
      type: "flowGroup",
      position: { x: group.x, y: group.y },
      data: { label: group.label },
      width: group.width,
      height: group.height,
      selectable: false,
      draggable: false,
      zIndex: 0
    }));

    const flowNodes: Node[] = layout.nodes.map((node) => ({
      id: node.id,
      type: "flowNode",
      position: { x: node.x, y: node.y },
      data: { label: node.label, kind: node.kind, direction },
      width: node.width,
      height: node.height,
      zIndex: 1
    }));

    const flowEdges: Edge[] = layout.edges.map((edge, index) => {
      const stroke = edge.dashed ? DASHED_STROKE : SOLID_STROKE;
      return {
        id: `edge-${index}-${edge.from}-${edge.to}`,
        source: edge.from,
        target: edge.to,
        label: edge.label,
        animated: edge.animated ?? false,
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
        style: {
          stroke,
          strokeWidth: 1.6,
          strokeDasharray: edge.dashed ? "5 5" : undefined
        },
        labelStyle: { fill: "#3a463f", fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4
      };
    });

    return { nodes: [...groupNodes, ...flowNodes], edges: flowEdges };
  }, [activeFlow, modelInfo]);

  // React Flow needs change handlers so it can write measured node dimensions
  // back into state; without them nodes never report as initialised and the
  // view never fits nor draws edges. useNodesState/useEdgesState provide those
  // handlers; this effect re-seeds them whenever the active flow changes.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(built.edges);

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  return (
    <Surface>
      <Surface.Header>
        <h2>Data flow architecture</h2>
      </Surface.Header>
      <PanelBody>
        <FlowTabs aria-label="Data flow diagrams">
          {FLOW_GROUPS.map((group) => (
            <FlowTabGroup key={group.title}>
              <FlowTabGroupTitle>{group.title}</FlowTabGroupTitle>
              <FlowTabGroupItems>
                {group.flows.map((flow) => (
                  <FlowTab
                    key={flow.key}
                    $active={activeFlow === flow.key}
                    onClick={() => setActiveFlow(flow.key)}
                    type="button"
                  >
                    {flow.title}
                  </FlowTab>
                ))}
              </FlowTabGroupItems>
            </FlowTabGroup>
          ))}
        </FlowTabs>

        <FlowCanvas>
          <ReactFlow
            // Remount per flow so fitView re-frames each diagram; the change
            // handlers above are what let nodes initialise in the first place.
            key={activeFlow}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={DATAFLOW_FIT_VIEW_OPTIONS}
            minZoom={DATAFLOW_MIN_ZOOM}
            maxZoom={DATAFLOW_MAX_ZOOM}
            proOptions={{ hideAttribution: false }}
            nodesConnectable={false}
            edgesFocusable={false}
          >
            <Background gap={20} color="#e2e7df" />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </FlowCanvas>

        <FlowLegend>
          <h3>System components</h3>
          <LegendItems>
            <LegendItem>
              <LegendBox style={{ background: "#fbfcfa", border: "2px solid #285f74" }} />
              <span>Source (Git)</span>
            </LegendItem>
            <LegendItem>
              <LegendBox style={{ background: "#e8f1f7", border: "2px solid #4a7c93" }} />
              <span>Processing</span>
            </LegendItem>
            <LegendItem>
              <LegendBox style={{ background: "#f0f4f0", border: "2px solid #3d6b43" }} />
              <span>Storage (Postgres)</span>
            </LegendItem>
            <LegendItem>
              <LegendBox style={{ background: "#fef9f0", border: "2px solid #8b5a00" }} />
              <span>AI Provider</span>
            </LegendItem>
            <LegendItem>
              <LegendBox style={{ background: "#f5f7f2", border: "2px solid #b8c0b4" }} />
              <span>User / API</span>
            </LegendItem>
            <LegendItem>
              <LegendBox style={{ background: "#fff3e6", border: "2px solid #c2541f" }} />
              <span>Reconcile gate</span>
            </LegendItem>
          </LegendItems>
        </FlowLegend>
      </PanelBody>
    </Surface>
  );
}
