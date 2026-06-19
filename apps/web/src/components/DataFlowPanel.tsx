"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { RuntimeConfig } from "../lib/types";
import { extractModelInfo } from "../lib/config";

type ModelInfo = ReturnType<typeof extractModelInfo>;
type FlowKey = "overview" | "ask" | "improvement" | "queue" | "automation" | "perflow";

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
          <button
            className={activeFlow === "perflow" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("perflow")}
          >
            Per-Flow Jobs
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
  if (flow === "perflow") {
    return perFlowJobsDiagram(modelInfo);
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
    Scheduler["⏱️ Scheduler<br/>(per-flow cron + run-lock)"]

    subgraph GapsTask["<b>gaps → pull requests</b><br/>(per flow · every 10 min)"]
        GPoll["🔍 Poll this flow's<br/>own open PRs"]
        GCluster["📊 Cluster this flow's<br/>open gaps"]
        GDraft["🤖 ${chatLabel}<br/>Draft Uncovered<br/>Clusters"]
        GPublish["🚀 Publish PRs<br/>(no manual review)"]
        GPoll --> GCluster
        GCluster --> GDraft
        GDraft --> GPublish
    end

    subgraph SyncTask["<b>source change → KB sync</b><br/>(per flow · every 10 min)"]
        SWatch["🔍 Watch this flow's<br/>git sources"]
        SRewrite["🤖 ${chatLabel}<br/>Rewrite outdated<br/>docs it already covers"]
        SBranch["🚀 Publish review branch"]
        SWatch --> SRewrite
        SRewrite --> SBranch
    end

    subgraph CrunchTask["<b>Crunch</b><br/>(per flow · scheduled or on-demand)"]
        CrPlan["🧹 ${chatLabel}<br/>Build Crunch Plan<br/>(tidy / consolidate)"]
        CrReview["👁️ Human Reviews<br/>Plan + Operations"]
        CrPublish["🚀 Publish Branch"]
        CrPlan --> CrReview
        CrReview -->|Publish| CrPublish
    end

    Scheduler -->|one job per flow| GPoll
    Scheduler -->|one job per flow| SWatch
    Scheduler -->|per flow| CrPlan

    GPublish --> Host["🌐 Git Host<br/>Pull Requests"]
    SBranch --> Host
    CrPublish --> Host
    Host -->|merged| Resolve["✅ Resolve Gaps<br/>+ Re-index KB"]
    Host -.->|next run| GPoll

    style GapsTask fill:#fef9f0,stroke:#8b5a00,stroke-width:2px
    style SyncTask fill:#e8f1f7,stroke:#285f74,stroke-width:2px
    style CrunchTask fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px`;
}

// Zooms into the per-flow reconciler: the scheduler fans out one job per flow,
// each with its own cron and run-lock, and every step inside a job is scoped to
// that flow alone — its own PRs, its own revision gate, its own outbox.
function perFlowJobsDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Sched["⏱️ Scheduler tick"]
    Sched -->|fan out: one job per flow| FA["🧵 Flow A job<br/>own cron + run-lock"]
    Sched -->|fan out: one job per flow| FB["🧵 Flow B job<br/>own cron + run-lock"]
    FA -.->|independent — a slow or stuck<br/>flow can't block the other| FB

    FA --> Poll

    subgraph Recon["<b>RECONCILER — scoped to Flow A</b>"]
        Poll["🔍 Poll only Flow A's<br/>own open PRs"]
        Gate{"Flow A's gap-catalog<br/>revision advanced?"}
        Cluster["📊 Cluster Flow A's gaps<br/>(reshape within flow only)"]
        Draft["🤖 ${chatLabel}<br/>Draft uncovered clusters"]
        Enqueue["📥 Enqueue publish<br/>(outbox)"]
        Outbox["📬 Drain Flow A's<br/>publish outbox"]
        Poll --> Gate
        Gate -->|unchanged| Outbox
        Gate -->|advanced| Cluster
        Cluster --> Draft
        Draft --> Enqueue
        Enqueue --> Outbox
    end

    Poll -->|merged| Resolve["✅ Resolve gaps<br/>+ Re-index KB"]
    Poll -->|closed| Reject["🚫 Mark rejected<br/>+ freeze cluster"]
    Outbox --> Host["🌐 Git Host<br/>Flow A's Pull Requests"]
    Host -.->|next run| Poll

    style Recon fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}
