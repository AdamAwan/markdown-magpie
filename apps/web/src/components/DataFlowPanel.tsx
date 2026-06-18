"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { RuntimeConfig } from "../lib/types";
import { extractModelInfo } from "../lib/config";

type ModelInfo = ReturnType<typeof extractModelInfo>;
type FlowKey = "overview" | "ask" | "improvement" | "queue" | "automation";

// Initialize mermaid exactly once on the client. startOnLoad is false because we
// render each diagram on demand via mermaid.run rather than letting it scan the
// DOM at load time.
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
  const graph = useMemo(() => buildDiagram(activeFlow, modelInfo), [activeFlow, modelInfo]);

  return (
    <div className="surface">
      <div className="surfaceHeader">
        <h2>Data Flow Architecture</h2>
      </div>
      <div className="surfaceBody dataFlowPanel">
        <div className="flowTabs">
          <button
            className={activeFlow === "overview" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("overview")}
          >
            Overview
          </button>
          <button
            className={activeFlow === "ask" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("ask")}
          >
            Ask Flow
          </button>
          <button
            className={activeFlow === "improvement" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("improvement")}
          >
            Continuous Improvement Cycle
          </button>
          <button
            className={activeFlow === "queue" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("queue")}
          >
            Queue Architecture
          </button>
          <button
            className={activeFlow === "automation" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("automation")}
          >
            Automation &amp; Crunch
          </button>
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

// Renders a single mermaid graph into a ref'd element. mermaid mutates the DOM
// node it processes and marks it with data-processed; to re-render when the graph
// changes we clear that flag, restore the source, and run mermaid against just
// this node. Wrapped in try/catch so a malformed graph leaves a readable error
// instead of crashing the panel.
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

  // key forces a fresh node per flow so mermaid never re-reads a half-processed one.
  return <div className="mermaid" key={flowKey} ref={ref} />;
}

function buildDiagram(flow: FlowKey, modelInfo: ModelInfo): string {
  if (flow === "ask") {
    return askFlowDiagram(modelInfo);
  }
  if (flow === "improvement") {
    return continuousImprovementDiagram(modelInfo);
  }
  if (flow === "queue") {
    return queueArchitectureDiagram(modelInfo);
  }
  if (flow === "automation") {
    return automationDiagram(modelInfo);
  }
  return overviewDiagram(modelInfo);
}

function overviewDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    A["📄 Git Markdown<br/>Repository"] -->|Sync| B["🔍 Parse &<br/>Index"]
    B -->|Generate| C["📚 Postgres DB<br/>Indexed Sections"]

    D["❓ User Question<br/>Web/MCP"] -->|Retrieve| E["🔎 Search<br/>Keyword + Vector"]
    E -->|Context| C
    C -->|Retrieved Sections| F["🤖 ${chatLabel}<br/>Synthesizes Answer"]
    F -->|With Citations| G["✓ Answer<br/>+ Citations"]

    subgraph Learn["<b>LEARN</b><br/>(Feedback Analysis)"]
        G -->|Store| H["💾 Log Answer<br/>& Feedback"]
        H -->|Auto-detect Low Conf| I["📋 Identify Gaps<br/>or Manual Flag"]
        I -->|Group Similar| J["📊 Cluster into<br/>Gap Candidates"]
    end

    subgraph Generate["<b>GENERATE</b><br/>(Solution Creation)"]
        J -->|Select Gap| K["🎯 Pick Gap<br/>Candidate"]
        K -->|Synthesize| L["🤖 ${chatLabel}<br/>Generates Proposal"]
        L -->|Store| M["💾 Save<br/>Proposal"]
    end

    M -->|Review| N["👤 Human Review<br/>or ⏱️ Scheduled<br/>Automation"]
    N -->|Approve / Auto-promote| O["📬 Publish<br/>Pull Request"]
    O -->|Merged on host| P["🔄 Resolve Gaps<br/>+ Re-index"]
    P -.->|Updated Docs| C

    style Learn fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px
    style Generate fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}

function askFlowDiagram(modelInfo: ModelInfo): string {
  const embedLabel = modelInfo.embeddingModel && modelInfo.embeddingHost
    ? `${modelInfo.embeddingModel}<br/>(${modelInfo.embeddingHost})`
    : modelInfo.embeddingModel || "Embedding Model";
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Start["❓ Question<br/>Web UI or MCP"]

    Start --> Keyword["🔍 Keyword Search<br/>in Postgres"]
    Keyword --> DecideMode{Execution<br/>Mode?}

    subgraph Direct["<b>DIRECT MODE</b>"]
        DirVector["🔢 Vector Search + RRF Fusion<br/>${embedLabel}<br/>(hybrid; keyword-only if no embeddings)"]
        DirContext["📚 Retrieved<br/>Context"]
        DirAI["🤖 ${chatLabel}<br/>(Synchronous)<br/>Generates Answer"]
        DirVector --> DirContext
        DirContext --> DirAI
    end

    subgraph Queue["<b>QUEUE MODE</b>"]
        JobCreate["📝 Create AI Job<br/>(keyword context)"]
        JobQueue["📦 Store in Queue<br/>(Postgres)"]
        WatcherClaim["👁️ Watcher<br/>Claims Job"]
        QueueAI["🤖 ${chatLabel}<br/>(When Claimed)<br/>Generates Answer"]
        JobStore["💾 Store Result"]
        JobCreate --> JobQueue
        JobQueue --> WatcherClaim
        WatcherClaim --> QueueAI
        QueueAI --> JobStore
    end

    DecideMode -->|Immediate| DirVector
    DecideMode -->|Deferred| JobCreate

    DirAI --> Log["💾 Log &<br/>Store"]
    JobStore --> Log

    Log --> Return["✓ Answer<br/>with Citations"]
    Return -->|Web UI| WebOut["🌐 Web<br/>Response"]
    Return -->|MCP| MCPOut["📡 MCP<br/>Response"]

    style Direct fill:#e8f1f7,stroke:#285f74,stroke-width:2px
    style Queue fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}

function continuousImprovementDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Start["❓ Questions Answered"] --> Feedback["📊 Collect Feedback"]

    subgraph Detection["<b>GAP DETECTION</b>"]
        Feedback -->|Low Confidence| Auto["🔴 Auto-detect"]
        Feedback -->|User Feedback| Manual["👤 Mark Unhelpful"]
        Auto --> Analyze["🔍 Analyze Patterns"]
        Manual --> Analyze
        Analyze --> Cluster["📊 Cluster Similar<br/>by Semantics"]
        Cluster --> Gaps["📋 Gap Candidates<br/>with Evidence"]
    end

    Gaps --> Path{Review<br/>Path?}

    subgraph ManualPath["<b>MANUAL (Human-in-the-loop)</b>"]
        ManualPick["👤 Human Picks<br/>Cluster to Draft"]
        ManualJob["📝 Create AI Job"]
        ManualSynth["🤖 ${chatLabel}<br/>Generates Proposal"]
        ManualReview["👁️ Human Reviews<br/>Markdown"]
        ManualPick --> ManualJob
        ManualJob --> ManualSynth
        ManualSynth --> ManualReview
        ManualReview -->|Changes| ManualJob
    end

    subgraph AutoPath["<b>AUTOMATED (cron: gaps → PRs)</b>"]
        AutoDraft["🤖 ${chatLabel}<br/>Auto-draft<br/>uncovered clusters"]
        AutoPromote["⏩ Auto-promote<br/>draft → ready<br/>(no manual review)"]
        AutoDraft --> AutoPromote
    end

    Path -->|Manual| ManualPick
    Path -->|Scheduled| AutoDraft

    ManualReview -->|Approved| Publish["🚀 Create Pull<br/>Request"]
    AutoPromote --> Publish

    Publish --> Merged{PR Outcome?}
    Merged -->|Merged on host| Resolve["✅ Resolve Gaps<br/>+ Re-index KB"]
    Merged -->|Closed| Rejected["🚫 Mark Rejected"]
    Resolve -->|Updated Docs| Start

    style Detection fill:#e8f1f7,stroke:#285f74,stroke-width:2px
    style ManualPath fill:#fef9f0,stroke:#8b5a00,stroke-width:2px
    style AutoPath fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px`;
}

function queueArchitectureDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    User["👤 User/Client<br/>Web UI or MCP"]

    subgraph Direct["<b>DIRECT MODE</b><br/>(Synchronous)"]
        DirReq["📨 Request"] --> DirAPI["🔌 API<br/>Process"]
        DirAPI --> DirModel["🤖 ${chatLabel}<br/>Called Directly"]
        DirModel --> DirResp["✓ Response<br/>Immediate"]
    end

    subgraph Queue["<b>QUEUE MODE</b><br/>(Asynchronous)"]
        QReq["📨 Request"] --> QJobCreate["📝 Create<br/>Job Record"]
        QJobCreate --> QQueue["📦 Job Queue<br/>Postgres"]
        QQueue --> QWatcher["👁️ Watcher<br/>Process"]
        QWatcher --> QModel["🤖 ${chatLabel}<br/>Called by Watcher"]
        QModel --> QResult["💾 Store<br/>Result"]
        QResult --> QResp["✓ Return<br/>Later"]
    end

    User -->|Option 1:<br/>Fast| Direct
    User -->|Option 2:<br/>Flexible| Queue

    DirResp --> Return["📤 Answer to User"]
    QResp --> Return

    style Direct fill:#e8f1f7,stroke:#285f74,stroke-width:2px
    style Queue fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}

function automationDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Scheduler["⏱️ Scheduler<br/>(cron settings per task)"]

    subgraph GapsTask["<b>gaps → pull requests</b><br/>(default: hourly)"]
        GCluster["📊 Cluster<br/>Open Gaps"]
        GDraft["🤖 ${chatLabel}<br/>Draft Uncovered<br/>Clusters"]
        GPromote["⏩ Auto-promote<br/>draft → ready"]
        GPublish["🚀 Publish PRs<br/>(no manual review)"]
        GCluster --> GDraft
        GDraft --> GPromote
        GPromote --> GPublish
    end

    subgraph CrunchTask["<b>Crunch</b><br/>(scheduled or on-demand)"]
        CrPlan["🧹 ${chatLabel}<br/>Build Crunch Plan<br/>(tidy / consolidate)"]
        CrReview["👁️ Human Reviews<br/>Plan + Operations"]
        CrPublish["🚀 Publish Branch"]
        CrPlan --> CrReview
        CrReview -->|Publish| CrPublish
    end

    subgraph PrTask["<b>PR status refresh</b><br/>(default: every 10 min)"]
        PrCheck["🔍 Check Open PRs<br/>on Host"]
        PrOutcome{Merged?}
        PrResolve["✅ Resolve Gaps<br/>+ Re-index KB"]
        PrReject["🚫 Mark Rejected"]
        PrCheck --> PrOutcome
        PrOutcome -->|Merged| PrResolve
        PrOutcome -->|Closed| PrReject
    end

    Scheduler --> GCluster
    Scheduler --> CrPlan
    Scheduler --> PrCheck

    GPublish --> Host["🌐 Git Host<br/>Pull Requests"]
    CrPublish --> Host
    Host --> PrCheck

    style GapsTask fill:#fef9f0,stroke:#8b5a00,stroke-width:2px
    style CrunchTask fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px
    style PrTask fill:#e8f1f7,stroke:#285f74,stroke-width:2px`;
}
