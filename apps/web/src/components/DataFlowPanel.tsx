"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { extractModelInfo } from "../lib/config";
import { RuntimeConfig } from "../lib/types";
import { buildDataFlowDiagram, FLOW_TABS, FlowKey } from "./data-flow-diagrams";

let mermaidInitialized = false;
function ensureMermaidInitialized() {
  if (!mermaidInitialized) {
    mermaid.initialize({ startOnLoad: false });
    mermaidInitialized = true;
  }
}

export function DataFlowPanel({ config }: { config?: RuntimeConfig }) {
  const [activeFlow, setActiveFlow] = useState<FlowKey>("overview");
  const modelInfo = useMemo(() => extractModelInfo(config), [config]);
  const graph = useMemo(() => buildDataFlowDiagram(activeFlow, modelInfo), [activeFlow, modelInfo]);

  return (
    <div className="surface">
      <div className="surfaceHeader">
        <h2>Data Flow Architecture</h2>
      </div>
      <div className="surfaceBody dataFlowPanel">
        <div className="flowTabs">
          {FLOW_TABS.map((flow) => (
            <button
              className={activeFlow === flow.key ? "flowTab active" : "flowTab"}
              key={flow.key}
              onClick={() => setActiveFlow(flow.key)}
            >
              {flow.label}
            </button>
          ))}
        </div>

        <div className="flowDiagram">
          <MermaidDiagram graph={graph} flowKey={activeFlow} />
        </div>

        <div className="flowLegend">
          <h3>System Components</h3>
          <div className="legendItems">
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#fbfcfa", border: "2px solid #285f74" }}></div>
              <span>Source (Git)</span>
            </div>
            <div className="legendItem">
              <div className="legendBox" style={{ background: "#e8f1f7" }}></div>
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
              <div className="legendBox" style={{ background: "#f5f7f2" }}></div>
              <span>User/API</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MermaidDiagram({ graph, flowKey }: { graph: string; flowKey: FlowKey }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    let cancelled = false;
    ensureMermaidInitialized();
    element.removeAttribute("data-processed");
    element.textContent = graph;

    void (async () => {
      try {
        await mermaid.run({ nodes: [element] });
      } catch (error) {
        if (!cancelled) {
          element.removeAttribute("data-processed");
          element.textContent = `Unable to render this diagram: ${
            error instanceof Error ? error.message : "unknown error"
          }`;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [graph]);

  return <div className="mermaid" key={flowKey} ref={ref} />;
}
