"use client";

import { useEffect, useMemo, useState } from "react";
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
import { FlowNode, GroupNode } from "./dataflow/FlowNode";

const nodeTypes: NodeTypes = {
  flowNode: FlowNode,
  flowGroup: GroupNode
};

// Colour the edge + arrowhead by whether it's a primary step or a dotted
// feedback/relationship link, matching the muted palette used elsewhere.
const SOLID_STROKE = "#5b6962";
const DASHED_STROKE = "#9aa69e";

export function DataFlowPanel({ config }: { config?: RuntimeConfig }) {
  const [activeFlow, setActiveFlow] = useState<FlowKey>("overview");
  const modelInfo = useMemo(() => extractModelInfo(config), [config]);

  const built = useMemo(() => {
    const graph = buildFlowGraph(activeFlow, modelInfo);
    const layout = layoutGraph(graph);

    // Provide width/height as top-level node fields (not just style) so React
    // Flow treats the nodes as already measured. That makes nodesInitialized
    // true synchronously Ã¢â‚¬â€ fitView frames the graph and edges resolve their
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
      data: { label: node.label, kind: node.kind },
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
    <div className="surface">
      <div className="surfaceHeader">
        <h2>Data Flow Architecture</h2>
      </div>
      <div className="surfaceBody dataFlowPanel">
        <div className="flowTabs" aria-label="Data flow diagrams">
          {FLOW_GROUPS.map((group) => (
            <div className="flowTabGroup" key={group.title}>
              <div className="flowTabGroupTitle">{group.title}</div>
              <div className="flowTabGroupItems">
                {group.flows.map((flow) => (
                  <button
                    key={flow.key}
                    className={activeFlow === flow.key ? "flowTab active" : "flowTab"}
                    onClick={() => setActiveFlow(flow.key)}
                    type="button"
                  >
                    {flow.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flowCanvas">
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
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: false }}
            nodesConnectable={false}
            edgesFocusable={false}
          >
            <Background gap={20} color="#e2e7df" />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="flowLegend">
          <h3>System Components</h3>
          <div className="legendItems">
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#fbfcfa", border: "2px solid #285f74" }}></div>
              <span>Source (Git)</span>
            </div>
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#e8f1f7", border: "2px solid #4a7c93" }}></div>
              <span>Processing</span>
            </div>
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#f0f4f0", border: "2px solid #3d6b43" }}></div>
              <span>Storage (Postgres)</span>
            </div>
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#fef9f0", border: "2px solid #8b5a00" }}></div>
              <span>AI Provider</span>
            </div>
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#f5f7f2", border: "2px solid #b8c0b4" }}></div>
              <span>User / API</span>
            </div>
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#fff3e6", border: "2px solid #c2541f" }}></div>
              <span>Reconcile gate</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
