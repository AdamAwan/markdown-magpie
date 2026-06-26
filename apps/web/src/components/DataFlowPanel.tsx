"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { RuntimeConfig } from "../lib/types";
import { extractModelInfo } from "../lib/config";

type ModelInfo = ReturnType<typeof extractModelInfo>;
type FlowKey = "overview" | "ask" | "improvement" | "automation" | "reconcile" | "gappr" | "perflow";

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
            Automation &amp; Patrol
          </button>
          <button
            className={activeFlow === "reconcile" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("reconcile")}
          >
            Reconcile Gate
          </button>
          <button
            className={activeFlow === "gappr" ? "flowTab active" : "flowTab"}
            onClick={() => setActiveFlow("gappr")}
          >
            Gap to PR Jobs
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
  if (flow === "reconcile") {
    return reconcileGateDiagram();
  }
  if (flow === "gappr") {
    return gapToPullRequestDiagram();
  }
  if (flow === "perflow") {
    return perFlowJobsDiagram();
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
        AutoDraft["📦 Provider job<br/>Auto-draft uncovered clusters<br/>(${chatLabel})"]
        AutoPromote["📦 GitHub job<br/>Auto-publish<br/>(skips human review)"]
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
        GRead["🔧 Maintenance watcher<br/>calls API reconciler"]
        GCluster["🧭 API assigns clusters<br/>+ enqueues reshape job"]
        GDraft["📦 Enqueue provider jobs<br/>to draft uncovered clusters"]
        GPublish["📦 Drain outbox + enqueue<br/>GitHub publication jobs"]
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

    subgraph PatrolTask["<b>Patrol</b><br/>(per flow · scheduled)"]
        PScan["🩺 ${chatLabel}<br/>Verify / dedupe / split /<br/>improve KB documents"]
        PProposal["📝 Draft proposals<br/>(reconciled via the gate)"]
        PPublish["🚀 Publish review branch"]
        PScan --> PProposal
        PProposal --> PPublish
    end

    Scheduler -->|one job per flow| FGather
    Scheduler -->|maintenance orchestrator job per flow| GRead
    Scheduler -->|one job per flow| SWatch
    Scheduler -->|per flow| PScan

    FWrite -.->|snapshot| GRead
    GPublish --> Host["🌐 Git Host<br/>Pull Requests"]
    SBranch --> Host
    PPublish --> Host
    Host -->|merged| Resolve["✅ Resolve Gaps<br/>+ Re-index KB"]
    Host -.->|next fetch| FPoll

    style FetchTask fill:#fbfcfa,stroke:#285f74,stroke-width:2px
    style GapsTask fill:#fef9f0,stroke:#8b5a00,stroke-width:2px
    style SyncTask fill:#e8f1f7,stroke:#285f74,stroke-width:2px
    style PatrolTask fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px`;
}

// The shared reconcile gate is the spine of the maintenance redesign: every
// producer (gaps, source-sync, the patrols) expresses its change as a
// ChangeIntent carrying the file paths it would touch, and the gate resolves
// each one against the flow's open PRs into open-new / fold / defer. This view
// makes that lens-agnostic pipeline explicit, and flags the one asymmetry that
// remains (source-sync cannot fold yet — Scope B).
function reconcileGateDiagram(): string {
  return `graph TD
    subgraph Triggers["<b>Per-flow scheduled triggers</b><br/>(on the watcher)"]
        T1["⏱️ Gaps → PRs<br/>drafts gap proposal"]
        T2["⏱️ Source sync<br/>rewrites stale docs"]
        T3["⏱️ Fix-patrol<br/>verify · dedupe · split"]
        T4["⏱️ Improve-patrol<br/>expands thin docs"]
    end

    T1 --> Intent["📨 ChangeIntent<br/>lens · flowId · file targets"]
    T2 --> Intent
    T3 --> Intent
    T4 --> Intent

    Intent --> Gate{"🚦 Reconcile gate<br/>file-set vs open PRs"}
    Gate -->|no overlap| New["🆕 Open-new<br/>fresh proposal"]
    Gate -->|overlaps touchable PR| Fold["🔀 Fold<br/>LLM-merge into open PR"]
    Gate -->|overlaps approved PR| Defer["⏸️ Defer<br/>re-gate next tick"]

    New --> Publish["🚀 publish_proposal<br/>opens PR"]
    Fold --> Publish
    Publish --> Review["👤 Human review<br/>→ merge"]
    Review --> Reindex["🔄 Re-index KB"]
    Reindex -.->|next tick| Gate

    T2 -.-> ScopeB
    Defer -.-> ScopeB
    ScopeB["⚠️ Scope B (proposed): source-sync isn't a Proposal yet,<br/>so it can only defer — never folds, publishes a branch with no PR"]

    style Triggers fill:#fbfcfa,stroke:#285f74,stroke-width:2px
    style Gate fill:#fef9f0,stroke:#8b5a00,stroke-width:2px
    style Fold fill:#f0f4f0,stroke:#3d6b43,stroke-width:2px
    style ScopeB fill:#faece7,stroke:#993c1d,stroke-width:2px`;
}

// A sequence diagram makes the job boundaries and capability hand-offs explicit.
// The maintenance watcher coordinates through the API; provider and GitHub work
// remain independently claimable queue jobs and may run on other watcher processes.
function gapToPullRequestDiagram(): string {
  return `sequenceDiagram
    autonumber
    participant S as Scheduler
    participant Q as pg-boss Job Queue
    participant M as Maintenance Watcher
    participant A as API Reconciler
    participant P as Provider Watcher
    participant G as GitHub Watcher
    participant H as Git Host

    Note over M,G: Watcher means worker process. A process advertises one or more capabilities but executes one job at a time.
    S->>Q: enqueue process_gaps_to_pull_requests
    Q->>M: claim [maintenance]
    M->>A: POST /api/gaps/reconcile
    A->>A: refresh PR state, revision gate, assign clusters

    opt two or more active clusters
        A->>Q: enqueue reconcile_gap_clusters
        Note over A,P: API bounded-waits for this provider job
        Q->>P: claim [configured AI provider]
        P-->>A: complete reshape job
    end

    loop each uncovered cluster
        A->>Q: enqueue draft_markdown_proposal
    end
    A-->>M: reconciliation request complete
    M-->>Q: complete maintenance job

    loop queued draft jobs
        Q->>P: claim [configured AI provider]
        P->>A: complete draft and store proposal and publish action
    end

    Note over S,A: A later reconcile drains publication actions after drafts complete
    S->>Q: enqueue next process_gaps_to_pull_requests
    Q->>M: claim [maintenance]
    M->>A: POST /api/gaps/reconcile
    A->>Q: enqueue publish_proposal
    A-->>M: reconciliation request complete
    M-->>Q: complete maintenance job

    Q->>G: claim publish_proposal [github]
    G->>H: push branch and open pull request
    G->>A: complete publish job and record PR URL

    Q->>G: claim refresh_pull_requests [github]
    G->>H: read PR state
    G->>A: complete refresh job
    A->>A: on merge, resolve gaps and re-index

    Note over M,P: The nested reshape needs another free provider-capable watcher. With only one watcher process, reshape times out and is skipped. Drafting still continues.`;
}
// Zooms into one flow's two jobs and the fetch/process split between them: a fetch
// job polls the host and writes a snapshot; the reconciler reads that snapshot and
// never touches the host in the steady state. Everything is scoped to the flow —
// its own PRs, its own revision gate, its own outbox, its own crons and run-locks.
function perFlowJobsDiagram(): string {
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
        ReadPR["🔧 API reconciler reads PR state<br/>(live poll only if missing)"]
        Gate{"Flow A's gap-catalog<br/>revision advanced?"}
        Cluster["🧭 Assign Flow A's gaps<br/>+ enqueue provider reshape job"]
        Draft["📦 Enqueue provider draft jobs<br/>for uncovered clusters"]
        Outbox["📦 Drain Flow A's outbox<br/>+ enqueue GitHub jobs"]
        ReadPR --> Gate
        Gate -->|unchanged| Outbox
        Gate -->|advanced| Cluster
        Cluster --> Draft
        Draft --> Outbox
    end

    Write -.->|snapshot| ReadPR
    ReadPR -->|merged| Resolve["✅ Resolve gaps<br/>+ Re-index KB"]
    ReadPR -->|closed| Reject["🚫 Mark rejected<br/>+ freeze cluster"]
    Outbox --> GitHubWorker["🔧 GitHub watcher<br/>pushes branch + opens PR"]
    GitHubWorker -.->|next fetch| Poll

    style Fetch fill:#fbfcfa,stroke:#285f74,stroke-width:2px
    style Recon fill:#fef9f0,stroke:#8b5a00,stroke-width:2px`;
}
