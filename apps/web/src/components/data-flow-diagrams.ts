import { extractModelInfo } from "../lib/config";

export type DataFlowModelInfo = ReturnType<typeof extractModelInfo>;
export type FlowKey = "overview" | "ask" | "improvement" | "automation" | "gappr" | "perflow";

export const FLOW_TABS: ReadonlyArray<{ key: FlowKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "ask", label: "Ask Flow" },
  { key: "improvement", label: "Continuous Improvement Cycle" },
  { key: "automation", label: "Automation & Patrol" },
  { key: "gappr", label: "Gap to PR Jobs" },
  { key: "perflow", label: "Per-Flow Jobs" }
];

export function buildDataFlowDiagram(flow: FlowKey, modelInfo: DataFlowModelInfo): string {
  if (flow === "ask") {
    return askFlowDiagram(modelInfo);
  }
  if (flow === "improvement") {
    return continuousImprovementDiagram(modelInfo);
  }
  if (flow === "automation") {
    return automationDiagram(modelInfo);
  }
  if (flow === "gappr") {
    return gapToPullRequestDiagram();
  }
  if (flow === "perflow") {
    return perFlowJobsDiagram();
  }
  return overviewDiagram(modelInfo);
}

function modelLabel(model?: string, host?: string, fallback = "Model"): string {
  if (model && host) {
    return `${model} (${host})`;
  }
  return model || fallback;
}

function overviewDiagram(modelInfo: DataFlowModelInfo): string {
  const chatLabel = modelLabel(modelInfo.chatModel, modelInfo.chatHost, "Chat Model");

  return `graph TD
    A["Git Markdown Repository"] -->|Sync| B["Parse and Index"]
    B -->|Generate| C["Postgres DB Indexed Sections"]

    D["User Question Web or MCP"] -->|Retrieve| E["Search Keyword and Vector"]
    E -->|Context| C
    C -->|Retrieved Sections| F["${chatLabel} Synthesizes Answer"]
    F -->|With Citations| G["Answer with Citations"]

    subgraph Learn [LEARN Feedback Analysis]
        G -->|Store| H["Log Answer and Feedback"]
        H -->|Auto-detect Low Confidence| I["Identify Gaps or Manual Flag"]
        I -->|Group Similar| J["Cluster into Gap Candidates"]
    end

    subgraph Generate [GENERATE Solution Creation]
        J -->|Select Gap| K["Pick Gap Candidate"]
        K -->|Synthesize| L["${chatLabel} Generates Proposal"]
        L -->|Store| M["Save Proposal"]
    end

    M -->|Review| N["Human Review or Scheduled Automation"]
    N -->|Approve or Auto-promote| O["Publish Pull Request"]
    O -->|Merged on host| P["Resolve Gaps and Re-index"]
    P -.->|Updated Docs| C`;
}

function askFlowDiagram(modelInfo: DataFlowModelInfo): string {
  const embedLabel = modelLabel(modelInfo.embeddingModel, modelInfo.embeddingHost, "Embedding Model");
  const chatLabel = modelLabel(modelInfo.chatModel, modelInfo.chatHost, "Chat Model");

  return `graph TD
    Start["Question from Web UI or MCP"]

    subgraph Api [API enqueue only]
        Log["Log Question in Postgres"]
        JobCreate["Create answer_question Job with flow candidates"]
        Log --> JobCreate
    end

    Start -->|POST /ask| Log
    JobCreate --> Queue["Job Queue in Postgres"]

    subgraph Watcher [WATCHER all generative work]
        Claim["Claim Job"]
        Route["${chatLabel} Routes to Best Flow"]
        Retrieve["POST /api/retrieve Keyword Vector RRF ${embedLabel}"]
        Answer["${chatLabel} Answers from Scoped Context"]
        Cite["Derive Citations from Retrieved Sections"]
        Claim --> Route
        Route --> Retrieve
        Retrieve --> Answer
        Answer --> Cite
    end

    Queue --> Claim
    Cite -->|complete job| Store["Store Answer Citations and Flow"]

    Store --> Return["Answer with Citations"]
    Return -->|Web UI long-poll| WebOut["Web Response"]
    Return -->|MCP poll| MCPOut["MCP Response"]`;
}

function continuousImprovementDiagram(modelInfo: DataFlowModelInfo): string {
  const chatLabel = modelLabel(modelInfo.chatModel, modelInfo.chatHost, "Chat Model");

  return `graph TD
    Start["Questions Answered"] --> Feedback["Collect Feedback"]

    subgraph Detection [GAP DETECTION]
        Feedback -->|Low Confidence| Auto["Auto-detect"]
        Feedback -->|Reviewer| Manual["Manually Flag Gap"]
        Auto --> Analyze["Analyze Patterns"]
        Manual --> Analyze
        Analyze --> Cluster["Cluster Similar Gaps with AI Reshape and Critic"]
        Cluster --> Gaps["Gap Candidates with Evidence"]
    end

    Gaps --> Path{Review Path?}

    subgraph ManualPath [MANUAL Human in the loop]
        ManualPick["Human Picks Cluster to Draft"]
        ManualJob["Create AI Job"]
        ManualSynth["${chatLabel} Generates Proposal"]
        ManualReview["Human Reviews Markdown"]
        ManualPick --> ManualJob
        ManualJob --> ManualSynth
        ManualSynth --> ManualReview
        ManualReview -->|Changes| ManualJob
    end

    subgraph AutoPath [AUTOMATED cron gaps to PRs]
        AutoDraft["Provider job Auto-drafts uncovered clusters with ${chatLabel}"]
        AutoPromote["GitHub job Auto-publishes and skips human review"]
        AutoDraft --> AutoPromote
    end

    Path -->|Manual| ManualPick
    Path -->|Scheduled| AutoDraft

    ManualReview -->|Approved| Publish["Create Pull Request"]
    AutoPromote --> Publish

    Publish --> Merged{PR Outcome?}
    Merged -->|Merged on host| Resolve["Resolve Gaps and Re-index KB"]
    Merged -->|Closed| Rejected["Mark Rejected"]
    Resolve -->|Updated Docs| Start`;
}

function automationDiagram(modelInfo: DataFlowModelInfo): string {
  const chatLabel = modelLabel(modelInfo.chatModel, modelInfo.chatHost, "Chat Model");

  return `graph TD
    Scheduler["Scheduler per-flow cron and run-lock"]

    subgraph FetchTask [snapshot refresh fetch per flow every 5 min]
        FGather["Gather this flow gaps and proposals"]
        FPoll["Poll open PRs conditional ETag"]
        FWrite["Write snapshot per-flow directory on disk"]
        FGather --> FPoll
        FPoll --> FWrite
    end

    subgraph GapsTask [gaps to pull requests process per flow every 10 min]
        GRead["Maintenance watcher calls API reconciler"]
        GCluster["API assigns clusters and enqueues reshape job"]
        GDraft["Enqueue provider jobs to draft uncovered clusters"]
        GPublish["Drain outbox and enqueue GitHub publication jobs"]
        GRead --> GCluster
        GCluster --> GDraft
        GDraft --> GPublish
    end

    subgraph SyncTask [source change to KB sync per flow every 10 min]
        SWatch["Watch this flow git sources"]
        SRewrite["${chatLabel} Rewrites outdated docs it already covers"]
        SBranch["Publish review branch"]
        SWatch --> SRewrite
        SRewrite --> SBranch
    end

    subgraph PatrolTask [Patrol per flow scheduled]
        PScan["${chatLabel} Verifies dedupes splits and improves KB documents"]
        PProposal["Draft proposals reconciled through the gate"]
        PPublish["Publish review branch"]
        PScan --> PProposal
        PProposal --> PPublish
    end

    Scheduler -->|one job per flow| FGather
    Scheduler -->|maintenance orchestrator job per flow| GRead
    Scheduler -->|one job per flow| SWatch
    Scheduler -->|per flow| PScan

    FWrite -.->|snapshot| GRead
    GPublish --> Host["Git Host Pull Requests"]
    SBranch --> Host
    PPublish --> Host
    Host -->|merged| Resolve["Resolve Gaps and Re-index KB"]
    Host -.->|next fetch| FPoll`;
}

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
    Q->>M: claim maintenance
    M->>A: POST /api/gaps/reconcile
    A->>A: refresh PR state, revision gate, assign clusters

    opt two or more active clusters
        A->>Q: enqueue reconcile_gap_clusters
        Note over A,P: API bounded-waits for this provider job
        Q->>P: claim configured AI provider
        P-->>A: complete reshape job
    end

    loop each uncovered cluster
        A->>Q: enqueue draft_markdown_proposal
    end
    A-->>M: reconciliation request complete
    M-->>Q: complete maintenance job

    loop queued draft jobs
        Q->>P: claim configured AI provider
        P->>A: complete draft and store proposal and publish action
    end

    Note over S,A: A later reconcile drains publication actions after drafts complete
    S->>Q: enqueue next process_gaps_to_pull_requests
    Q->>M: claim maintenance
    M->>A: POST /api/gaps/reconcile
    A->>Q: enqueue publish_proposal
    A-->>M: reconciliation request complete
    M-->>Q: complete maintenance job

    Q->>G: claim publish_proposal with github capability
    G->>H: push branch and open pull request
    G->>A: complete publish job and record PR URL

    Q->>G: claim refresh_pull_requests with github capability
    G->>H: read PR state
    G->>A: complete refresh job
    A->>A: on merge, resolve gaps and re-index

    Note over M,P: The nested reshape needs another free provider-capable watcher. With only one watcher process, reshape times out and is skipped. Drafting still continues.`;
}

function perFlowJobsDiagram(): string {
  return `graph TD
    Sched["Scheduler tick"]
    Sched -->|fan out jobs per flow| FA["Flow A jobs own crons and run-locks"]
    Sched -->|fan out jobs per flow| FB["Flow B jobs own crons and run-locks"]
    FA -.->|independent slow flow cannot block the other| FB

    FA --> Gather
    FA --> ReadPR

    subgraph Fetch [FETCH snapshot refresh Flow A about 5 min]
        Gather["Gather Flow A gaps and proposals"]
        Poll["Poll only Flow A open PRs conditional ETag"]
        Write["Write snapshot to disk"]
        Gather --> Poll
        Poll --> Write
    end

    subgraph Recon [PROCESS reconciler Flow A about 10 min]
        ReadPR["API reconciler reads PR state"]
        Gate{Flow A gap-catalog revision advanced?}
        Cluster["Assign Flow A gaps and enqueue provider reshape job"]
        Draft["Enqueue provider draft jobs for uncovered clusters"]
        Outbox["Drain Flow A outbox and enqueue GitHub jobs"]
        ReadPR --> Gate
        Gate -->|unchanged| Outbox
        Gate -->|advanced| Cluster
        Cluster --> Draft
        Draft --> Outbox
    end

    Write -.->|snapshot| ReadPR
    ReadPR -->|merged| Resolve["Resolve gaps and Re-index KB"]
    ReadPR -->|closed| Reject["Mark rejected and freeze cluster"]
    Outbox --> GitHubWorker["GitHub watcher pushes branch and opens PR"]
    GitHubWorker -.->|next fetch| Poll`;
}
