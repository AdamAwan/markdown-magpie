"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { RuntimeConfig } from "../lib/types";
import { extractModelInfo } from "../lib/config";

type ModelInfo = ReturnType<typeof extractModelInfo>;
type FlowKey = "overview" | "ask" | "improvement" | "automation" | "perflow";

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

// Every question is answered the same way: enqueue-only. The API just logs the
// question and creates an answer_question job carrying the routing candidates; all
// generative work (route → retrieve → answer) runs in the watcher. There is no
// synchronous/direct path — the API never calls the model itself.
function askFlowDiagram(modelInfo: ModelInfo): string {
  const embedLabel = modelInfo.embeddingModel && modelInfo.embeddingHost
    ? `${modelInfo.embeddingModel}<br/>(${modelInfo.embeddingHost})`
    : modelInfo.embeddingModel || "Embedding Model";
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Start["❓ Question<br/>Web UI or MCP"]

    subgraph Api["<b>API</b> (enqueue-only)"]
        Log["💾 Log Question<br/>(Postgres)"]
        JobCreate["📝 Create answer_question Job<br/>(carries flow candidates)"]
        Log --> JobCreate
    end

    Start -->|POST /ask| Log
    JobCreate --> Queue["📦 Job Queue<br/>(Postgres)"]

    subgraph Watcher["<b>WATCHER</b> (all generative work)"]
        Claim["👁️ Claim Job"]
        Route["🧭 ${chatLabel}<br/>Route to best Flow"]
        Retrieve["🔎 POST /api/retrieve<br/>Keyword + Vector + RRF<br/>${embedLabel}<br/>(hybrid; keyword-only if no embeddings)"]
        Answer["🤖 ${chatLabel}<br/>Answer from scoped context"]
        Cite["🔖 Derive Citations<br/>from retrieved sections"]
        Claim --> Route
        Route --> Retrieve
        Retrieve --> Answer
        Answer --> Cite
    end

    Queue --> Claim
    Cite -->|complete job| Store["💾 Store Answer<br/>+ Citations + Flow"]

    Store --> Return["✓ Answer<br/>with Citations"]
    Return -->|Web UI long-poll| WebOut["🌐 Web<br/>Response"]
    Return -->|MCP poll| MCPOut["📡 MCP<br/>Response"]

    style Api fill:#f5f7f2,stroke:#285f74,stroke-width:2px
    style Watcher fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}

function continuousImprovementDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Start["❓ Questions Answered"] --> Feedback["📊 Collect Feedback"]

    subgraph Detection["<b>GAP DETECTION</b>"]
        Feedback -->|Low Confidence| Auto["🔴 Auto-detect"]
        Feedback -->|Reviewer| Manual["👤 Manually Flag Gap"]
        Auto --> Analyze["🔍 Analyze Patterns"]
        Manual --> Analyze
        Analyze --> Cluster["📊 Cluster Similar Gaps<br/>(AI reshape + critic)"]
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
        AutoPromote["⏩ Auto-publish<br/>(skips human review)"]
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

function automationDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Scheduler["⏱️ Scheduler<br/>(per-flow cron + run-lock)"]

    subgraph FetchTask["<b>snapshot refresh</b> · fetch<br/>(per flow · every 5 min)"]
        FGather["📥 Gather this flow's<br/>gaps + proposals"]
        FPoll["🔍 Poll open PRs (conditional)<br/>ETag 304s cost no rate limit"]
        FWrite["💾 Write snapshot<br/>(per-flow dir on disk)"]
        FGather --> FPoll
        FPoll --> FWrite
    end

    subgraph GapsTask["<b>gaps → pull requests</b> · process<br/>(per flow · every 10 min)"]
        GRead["📖 Read PR state<br/>from snapshot"]
        GCluster["📊 Cluster this flow's gaps"]
        GDraft["🤖 ${chatLabel}<br/>Draft uncovered clusters"]
        GPublish["🚀 Publish PRs<br/>(no manual review)"]
        GRead --> GCluster
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

    Scheduler -->|one job per flow| FGather
    Scheduler -->|one job per flow| GRead
    Scheduler -->|one job per flow| SWatch
    Scheduler -->|per flow| CrPlan

    FWrite -.->|snapshot| GRead
    GPublish --> Host["🌐 Git Host<br/>Pull Requests"]
    SBranch --> Host
    CrPublish --> Host
    Host -->|merged| Resolve["✅ Resolve Gaps<br/>+ Re-index KB"]
    Host -.->|next fetch| FPoll

    style FetchTask fill:#fbfcfa,stroke:#285f74,stroke-width:2px
    style GapsTask fill:#fef9f0,stroke:#8b5a00,stroke-width:2px
    style SyncTask fill:#e8f1f7,stroke:#285f74,stroke-width:2px
    style CrunchTask fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px`;
}

// Zooms into one flow's two jobs and the fetch/process split between them: a fetch
// job polls the host and writes a snapshot; the reconciler reads that snapshot and
// never touches the host in the steady state. Everything is scoped to the flow —
// its own PRs, its own revision gate, its own outbox, its own crons and run-locks.
function perFlowJobsDiagram(modelInfo: ModelInfo): string {
  const chatLabel = modelInfo.chatModel && modelInfo.chatHost
    ? `${modelInfo.chatModel}<br/>(${modelInfo.chatHost})`
    : modelInfo.chatModel || "Chat Model";

  return `graph TD
    Sched["⏱️ Scheduler tick"]
    Sched -->|fan out: jobs per flow| FA["🧵 Flow A jobs<br/>own crons + run-locks"]
    Sched -->|fan out: jobs per flow| FB["🧵 Flow B jobs<br/>own crons + run-locks"]
    FA -.->|independent — a slow or stuck<br/>flow can't block the other| FB

    FA --> Gather
    FA --> ReadPR

    subgraph Fetch["<b>FETCH</b> · snapshot refresh (Flow A · ~5 min)"]
        Gather["📥 Gather Flow A's<br/>gaps + proposals"]
        Poll["🔍 Poll only Flow A's open PRs<br/>(conditional · ETag)"]
        Write["💾 Write snapshot<br/>to disk"]
        Gather --> Poll
        Poll --> Write
    end

    subgraph Recon["<b>PROCESS</b> · reconciler (Flow A · ~10 min)"]
        ReadPR["📖 Read PR state from snapshot<br/>(live poll only if missing)"]
        Gate{"Flow A's gap-catalog<br/>revision advanced?"}
        Cluster["📊 Cluster Flow A's gaps<br/>(reshape within flow only)"]
        Draft["🤖 ${chatLabel}<br/>Draft uncovered clusters"]
        Outbox["📬 Drain Flow A's<br/>publish outbox"]
        ReadPR --> Gate
        Gate -->|unchanged| Outbox
        Gate -->|advanced| Cluster
        Cluster --> Draft
        Draft --> Outbox
    end

    Write -.->|snapshot| ReadPR
    ReadPR -->|merged| Resolve["✅ Resolve gaps<br/>+ Re-index KB"]
    ReadPR -->|closed| Reject["🚫 Mark rejected<br/>+ freeze cluster"]
    Outbox --> Host["🌐 Git Host<br/>Flow A's Pull Requests"]
    Host -.->|next fetch| Poll

    style Fetch fill:#fbfcfa,stroke:#285f74,stroke-width:2px
    style Recon fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}
