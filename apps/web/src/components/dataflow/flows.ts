import type { extractModelInfo } from "../../lib/config";
import type { FlowGraph } from "./types";

// The model picker injects the configured chat/embedding model into the
// diagrams so the architecture view reflects the live deployment rather than a
// generic placeholder.
type ModelInfo = ReturnType<typeof extractModelInfo>;

export type FlowKey =
  | "overview"
  | "ask"
  | "improvement"
  | "automation"
  | "reconcile"
  | "gappr"
  | "perflow";

export interface FlowDef {
  key: FlowKey;
  title: string;
  build: (modelInfo: ModelInfo) => FlowGraph;
}

export interface FlowGroupDef {
  title: string;
  flows: FlowDef[];
}

function chatLabel(modelInfo: ModelInfo): string {
  if (modelInfo.chatModel && modelInfo.chatHost) {
    return `${modelInfo.chatModel}\n(${modelInfo.chatHost})`;
  }
  return modelInfo.chatModel ?? "Chat Model";
}

function embedLabel(modelInfo: ModelInfo): string {
  if (modelInfo.embeddingModel && modelInfo.embeddingHost) {
    return `${modelInfo.embeddingModel}\n(${modelInfo.embeddingHost})`;
  }
  return modelInfo.embeddingModel ?? "Embedding Model";
}

function overview(modelInfo: ModelInfo): FlowGraph {
  const chat = chatLabel(modelInfo);
  return {
    direction: "LR",
    groups: [
      { id: "learn", label: "LEARN · Feedback Analysis" },
      { id: "generate", label: "GENERATE · Solution Creation" }
    ],
    nodes: [
      { id: "repo", kind: "source", label: "📄 Git Markdown\nRepository" },
      { id: "parse", kind: "processing", label: "🔍 Parse &\nIndex" },
      { id: "db", kind: "storage", label: "📚 Postgres DB\nIndexed Sections" },
      { id: "question", kind: "user", label: "❓ User Question\nWeb / MCP" },
      { id: "search", kind: "processing", label: "🔎 Search\nKeyword + Vector" },
      { id: "synth", kind: "ai", label: `🤖 ${chat}\nSynthesizes Answer` },
      { id: "answer", kind: "user", label: "✓ Answer\n+ Citations" },
      { id: "log", kind: "storage", label: "💾 Log Answer\n& Feedback", group: "learn" },
      { id: "identify", kind: "processing", label: "📋 Identify Gaps\nor Manual Flag", group: "learn" },
      { id: "cluster", kind: "processing", label: "📊 Cluster into\nGap Candidates", group: "learn" },
      { id: "pick", kind: "processing", label: "🎯 Pick Gap\nCandidate", group: "generate" },
      { id: "propose", kind: "ai", label: `🤖 ${chat}\nGenerates Proposal`, group: "generate" },
      { id: "save", kind: "storage", label: "💾 Save\nProposal", group: "generate" },
      { id: "review", kind: "user", label: "👤 Human Review\nor ⏱️ Scheduled Automation" },
      { id: "publish", kind: "user", label: "📬 Publish\nPull Request" },
      { id: "resolve", kind: "processing", label: "🔄 Resolve Gaps\n+ Re-index" }
    ],
    edges: [
      { from: "repo", to: "parse", label: "Sync" },
      { from: "parse", to: "db", label: "Generate" },
      { from: "question", to: "search", label: "Retrieve" },
      { from: "search", to: "db" },
      { from: "db", to: "synth", label: "Retrieved Sections" },
      { from: "synth", to: "answer", label: "With Citations" },
      { from: "answer", to: "log", label: "Store" },
      { from: "log", to: "identify", label: "Auto-detect Low Conf" },
      { from: "identify", to: "cluster", label: "Group Similar" },
      { from: "cluster", to: "pick", label: "Select Gap" },
      { from: "pick", to: "propose", label: "Synthesize" },
      { from: "propose", to: "save", label: "Store" },
      { from: "save", to: "review", label: "Review" },
      { from: "review", to: "publish", label: "Approve / Auto-promote" },
      { from: "publish", to: "resolve", label: "Merged on host" },
      { from: "resolve", to: "db", label: "Updated Docs", dashed: true }
    ]
  };
}

function ask(modelInfo: ModelInfo): FlowGraph {
  const chat = chatLabel(modelInfo);
  const embed = embedLabel(modelInfo);
  return {
    direction: "LR",
    groups: [
      { id: "api", label: "API · enqueue-only" },
      { id: "watcher", label: "WATCHER · all generative work" }
    ],
    nodes: [
      { id: "start", kind: "user", label: "❓ Question\nWeb UI or MCP" },
      { id: "logq", kind: "storage", label: "💾 Log Question\n(Postgres)", group: "api" },
      {
        id: "jobcreate",
        kind: "processing",
        label: "📝 Create answer_question Job\n(carries flow candidates)",
        group: "api"
      },
      { id: "queue", kind: "storage", label: "📦 Job Queue\n(Postgres)" },
      { id: "claim", kind: "processing", label: "👁️ Claim Job", group: "watcher" },
      { id: "route", kind: "ai", label: `🧭 ${chat}\nRoute to best Flow`, group: "watcher" },
      {
        id: "retrieve",
        kind: "processing",
        label: `🔎 POST /api/retrieve\nKeyword + Vector + RRF\n${embed}`,
        group: "watcher"
      },
      { id: "answerq", kind: "ai", label: `🤖 ${chat}\nAnswer from scoped context`, group: "watcher" },
      {
        id: "cite",
        kind: "processing",
        label: "🔖 Derive Citations\nfrom retrieved sections",
        group: "watcher"
      },
      { id: "store", kind: "storage", label: "💾 Store Answer\n+ Citations + Flow" },
      { id: "return", kind: "user", label: "✓ Answer\nwith Citations" },
      { id: "web", kind: "user", label: "🌐 Web\nResponse" },
      { id: "mcp", kind: "user", label: "📡 MCP\nResponse" }
    ],
    edges: [
      { from: "start", to: "logq", label: "POST /ask" },
      { from: "logq", to: "jobcreate" },
      { from: "jobcreate", to: "queue" },
      { from: "queue", to: "claim" },
      { from: "claim", to: "route" },
      { from: "route", to: "retrieve" },
      { from: "retrieve", to: "answerq" },
      { from: "answerq", to: "cite" },
      { from: "cite", to: "store", label: "complete job" },
      { from: "store", to: "return" },
      { from: "return", to: "web", label: "Web UI long-poll" },
      { from: "return", to: "mcp", label: "MCP poll" }
    ]
  };
}

function improvement(modelInfo: ModelInfo): FlowGraph {
  const chat = chatLabel(modelInfo);
  return {
    direction: "TB",
    groups: [
      { id: "detection", label: "GAP DETECTION" },
      { id: "manual", label: "MANUAL · Human-in-the-loop" },
      { id: "auto", label: "AUTOMATED · cron: gaps → PRs" }
    ],
    nodes: [
      { id: "start", kind: "user", label: "❓ Questions Answered" },
      { id: "feedback", kind: "processing", label: "📊 Collect Feedback" },
      { id: "autodetect", kind: "processing", label: "🔴 Auto-detect", group: "detection" },
      { id: "flag", kind: "user", label: "👤 Manually Flag Gap", group: "detection" },
      { id: "analyze", kind: "processing", label: "🔍 Analyze Patterns", group: "detection" },
      {
        id: "cluster",
        kind: "ai",
        label: "📊 Cluster Similar Gaps\n(AI reshape + critic)",
        group: "detection"
      },
      { id: "gaps", kind: "storage", label: "📋 Gap Candidates\nwith Evidence", group: "detection" },
      { id: "path", kind: "decision", label: "Review\nPath?" },
      { id: "pick", kind: "user", label: "👤 Human Picks\nCluster to Draft", group: "manual" },
      { id: "job", kind: "processing", label: "📝 Create AI Job", group: "manual" },
      { id: "synth", kind: "ai", label: `🤖 ${chat}\nGenerates Proposal`, group: "manual" },
      { id: "humanreview", kind: "user", label: "👁️ Human Reviews\nMarkdown", group: "manual" },
      {
        id: "autodraft",
        kind: "ai",
        label: `📦 Provider job\nAuto-draft uncovered clusters\n(${chat})`,
        group: "auto"
      },
      {
        id: "autopromote",
        kind: "processing",
        label: "📦 GitHub job\nAuto-publish\n(skips human review)",
        group: "auto"
      },
      { id: "publish", kind: "user", label: "🚀 Create Pull\nRequest" },
      { id: "outcome", kind: "decision", label: "PR Outcome?" },
      { id: "resolve", kind: "processing", label: "✅ Resolve Gaps\n+ Re-index KB" },
      { id: "rejected", kind: "user", label: "🚫 Mark Rejected" }
    ],
    edges: [
      { from: "start", to: "feedback" },
      { from: "feedback", to: "autodetect", label: "Low Confidence" },
      { from: "feedback", to: "flag", label: "Reviewer" },
      { from: "autodetect", to: "analyze" },
      { from: "flag", to: "analyze" },
      { from: "analyze", to: "cluster" },
      { from: "cluster", to: "gaps" },
      { from: "gaps", to: "path" },
      { from: "path", to: "pick", label: "Manual" },
      { from: "path", to: "autodraft", label: "Scheduled" },
      { from: "pick", to: "job" },
      { from: "job", to: "synth" },
      { from: "synth", to: "humanreview" },
      { from: "humanreview", to: "job", label: "Changes", dashed: true },
      { from: "autodraft", to: "autopromote" },
      { from: "humanreview", to: "publish", label: "Approved" },
      { from: "autopromote", to: "publish" },
      { from: "publish", to: "outcome" },
      { from: "outcome", to: "resolve", label: "Merged on host" },
      { from: "outcome", to: "rejected", label: "Closed" },
      { from: "resolve", to: "start", label: "Updated Docs", dashed: true }
    ]
  };
}

function automation(modelInfo: ModelInfo): FlowGraph {
  const chat = chatLabel(modelInfo);
  return {
    direction: "LR",
    groups: [
      { id: "fetch", label: "snapshot refresh · fetch (per flow · ~5 min)" },
      { id: "gaps", label: "gaps → pull requests · process (per flow · ~10 min)" },
      { id: "sync", label: "source change → KB sync (per flow · ~10 min)" },
      { id: "patrol", label: "Patrol (per flow · scheduled)" }
    ],
    nodes: [
      { id: "scheduler", kind: "user", label: "⏱️ Scheduler\n(per-flow cron + run-lock)" },
      { id: "fgather", kind: "processing", label: "📥 Gather this flow's\ngaps + proposals", group: "fetch" },
      {
        id: "fpoll",
        kind: "processing",
        label: "🔍 Poll open PRs (conditional)\nETag 304s cost no rate limit",
        group: "fetch"
      },
      { id: "fwrite", kind: "storage", label: "💾 Write snapshot\n(per-flow dir on disk)", group: "fetch" },
      { id: "gread", kind: "processing", label: "🔧 Maintenance watcher\ncalls API reconciler", group: "gaps" },
      {
        id: "gcluster",
        kind: "processing",
        label: "🧭 API assigns clusters\n+ enqueues reshape job",
        group: "gaps"
      },
      {
        id: "gdraft",
        kind: "processing",
        label: "📦 Enqueue provider jobs\nto draft uncovered clusters",
        group: "gaps"
      },
      {
        id: "gpublish",
        kind: "processing",
        label: "📦 Drain outbox + enqueue\nGitHub publication jobs",
        group: "gaps"
      },
      { id: "swatch", kind: "source", label: "🔍 Watch this flow's\ngit sources", group: "sync" },
      {
        id: "srewrite",
        kind: "ai",
        label: `🤖 ${chat}\nRewrite outdated\ndocs it already covers`,
        group: "sync"
      },
      {
        id: "sproposal",
        kind: "processing",
        label: "📝 Draft proposal\n(reconciled via the gate)",
        group: "sync"
      },
      {
        id: "pscan",
        kind: "ai",
        label: `🩺 ${chat}\nVerify / dedupe / split /\nimprove KB documents`,
        group: "patrol"
      },
      {
        id: "pproposal",
        kind: "processing",
        label: "📝 Draft proposals\n(reconciled via the gate)",
        group: "patrol"
      },
      { id: "ppublish", kind: "processing", label: "🚀 Publish via the gate", group: "patrol" },
      { id: "host", kind: "source", label: "🌐 Git Host\nPull Requests" },
      { id: "resolve", kind: "processing", label: "✅ Resolve Gaps\n+ Re-index KB" }
    ],
    edges: [
      { from: "scheduler", to: "fgather", label: "one job per flow" },
      { from: "scheduler", to: "gread", label: "maintenance orchestrator job per flow" },
      { from: "scheduler", to: "swatch", label: "one job per flow" },
      { from: "scheduler", to: "pscan", label: "per flow" },
      { from: "fgather", to: "fpoll" },
      { from: "fpoll", to: "fwrite" },
      { from: "gread", to: "gcluster" },
      { from: "gcluster", to: "gdraft" },
      { from: "gdraft", to: "gpublish" },
      { from: "swatch", to: "srewrite" },
      { from: "srewrite", to: "sproposal" },
      { from: "pscan", to: "pproposal" },
      { from: "pproposal", to: "ppublish" },
      { from: "fwrite", to: "gread", label: "snapshot", dashed: true },
      { from: "gpublish", to: "host" },
      { from: "sproposal", to: "host", label: "fold / open PR" },
      { from: "ppublish", to: "host" },
      { from: "host", to: "resolve", label: "merged" },
      { from: "host", to: "fpoll", label: "next fetch", dashed: true }
    ]
  };
}

// Post-Scope-B view: source-sync is now a first-class proposal, so all four
// producers express a ChangeIntent and pass through the same gate symmetrically.
// The gate resolves each intent against the flow's open PRs into open-new /
// fold / defer — source-sync folds like any other lens (no more defer-only
// asymmetry).
function reconcile(): FlowGraph {
  return {
    direction: "LR",
    groups: [{ id: "triggers", label: "Per-flow scheduled triggers (on the watcher)" }],
    nodes: [
      { id: "gapsTrigger", kind: "processing", label: "⏱️ Gaps → PRs\ndrafts gap proposal", group: "triggers" },
      {
        id: "syncTrigger",
        kind: "processing",
        label: "⏱️ Source sync\nrewrites stale docs",
        group: "triggers"
      },
      {
        id: "fixTrigger",
        kind: "processing",
        label: "⏱️ Fix-patrol\nverify · dedupe · split",
        group: "triggers"
      },
      {
        id: "improveTrigger",
        kind: "processing",
        label: "⏱️ Improve-patrol\nexpands thin docs",
        group: "triggers"
      },
      { id: "intent", kind: "processing", label: "📨 ChangeIntent\nlens · flowId · file targets" },
      { id: "gate", kind: "highlight", label: "🚦 Reconcile gate\nfile-set vs open PRs" },
      { id: "new", kind: "processing", label: "🆕 Open-new\nfresh proposal" },
      { id: "fold", kind: "processing", label: "🔀 Fold\nLLM-merge into open PR" },
      { id: "defer", kind: "processing", label: "⏸️ Defer\nre-gate next tick" },
      { id: "publish", kind: "user", label: "🚀 publish_proposal\nopens PR" },
      { id: "humanreview", kind: "user", label: "👤 Human review\n→ merge" },
      { id: "reindex", kind: "processing", label: "🔄 Re-index KB" }
    ],
    edges: [
      { from: "gapsTrigger", to: "intent" },
      { from: "syncTrigger", to: "intent" },
      { from: "fixTrigger", to: "intent" },
      { from: "improveTrigger", to: "intent" },
      { from: "intent", to: "gate" },
      { from: "gate", to: "new", label: "no overlap → open-new" },
      { from: "gate", to: "fold", label: "overlaps open PR → fold" },
      { from: "gate", to: "defer", label: "overlaps approved PR → defer" },
      { from: "new", to: "publish" },
      { from: "fold", to: "publish" },
      { from: "publish", to: "humanreview" },
      { from: "humanreview", to: "reindex" },
      { from: "reindex", to: "gate", label: "next tick", dashed: true },
      { from: "defer", to: "gate", label: "re-gate next tick", dashed: true }
    ]
  };
}

function gappr(): FlowGraph {
  return {
    direction: "LR",
    groups: [{ id: "reshape", label: "if ≥2 active clusters (bounded wait)" }],
    nodes: [
      {
        id: "scheduler",
        kind: "user",
        label: "⏱️ Scheduler\nenqueue process_gaps_to_pull_requests"
      },
      { id: "queue", kind: "storage", label: "📦 pg-boss Job Queue" },
      { id: "maintenance", kind: "processing", label: "🔧 Maintenance Watcher\nclaim [maintenance]" },
      {
        id: "reconciler",
        kind: "processing",
        label: "🧭 API Reconciler\nrefresh PR state · revision gate\nassign clusters"
      },
      { id: "reshapeJob", kind: "processing", label: "📦 enqueue\nreconcile_gap_clusters", group: "reshape" },
      { id: "provider", kind: "ai", label: "🤖 Provider Watcher\nreshape clusters", group: "reshape" },
      {
        id: "draftJob",
        kind: "processing",
        label: "📦 enqueue draft_markdown_proposal\n(per uncovered cluster)"
      },
      {
        id: "providerDraft",
        kind: "ai",
        label: "🤖 Provider Watcher\ndraft + store proposal\n+ publish action"
      },
      {
        id: "drain",
        kind: "processing",
        label: "🧭 API Reconciler (next tick)\ndrain publication → enqueue publish_proposal"
      },
      { id: "github", kind: "user", label: "🚀 GitHub Watcher\npush branch + open PR" },
      { id: "host", kind: "source", label: "🌐 Git Host\nPull Request" },
      { id: "refresh", kind: "processing", label: "🔄 GitHub Watcher\nrefresh_pull_requests" },
      { id: "merge", kind: "processing", label: "✅ API on merge\nresolve gaps + re-index" }
    ],
    edges: [
      { from: "scheduler", to: "queue" },
      { from: "queue", to: "maintenance", label: "claim" },
      { from: "maintenance", to: "reconciler", label: "POST /api/gaps/reconcile" },
      { from: "reconciler", to: "reshapeJob", label: "≥2 clusters" },
      { from: "reshapeJob", to: "provider", label: "claim [provider]" },
      { from: "provider", to: "reconciler", label: "complete reshape", dashed: true },
      { from: "reconciler", to: "draftJob", label: "each uncovered cluster" },
      { from: "draftJob", to: "providerDraft", label: "claim [provider]" },
      { from: "providerDraft", to: "drain", label: "stored", dashed: true },
      { from: "drain", to: "github", label: "claim publish_proposal [github]" },
      { from: "github", to: "host", label: "push + open PR" },
      { from: "host", to: "refresh", label: "read PR state", dashed: true },
      { from: "refresh", to: "merge" }
    ]
  };
}

function perflow(): FlowGraph {
  return {
    direction: "LR",
    groups: [
      { id: "fetch", label: "FETCH · snapshot refresh (Flow A · ~5 min)" },
      { id: "recon", label: "PROCESS · reconciler (Flow A · ~10 min)" }
    ],
    nodes: [
      { id: "sched", kind: "user", label: "⏱️ Scheduler tick" },
      { id: "fa", kind: "processing", label: "🧵 Flow A jobs\nown crons + run-locks" },
      { id: "fb", kind: "processing", label: "🧵 Flow B jobs\nown crons + run-locks" },
      { id: "gather", kind: "processing", label: "📥 Gather Flow A's\ngaps + proposals", group: "fetch" },
      {
        id: "poll",
        kind: "processing",
        label: "🔍 Poll only Flow A's open PRs\n(conditional · ETag)",
        group: "fetch"
      },
      { id: "write", kind: "storage", label: "💾 Write snapshot\nto disk", group: "fetch" },
      {
        id: "readpr",
        kind: "processing",
        label: "🔧 API reconciler reads PR state\n(live poll only if missing)",
        group: "recon"
      },
      { id: "gate", kind: "decision", label: "Flow A's gap-catalog\nrevision advanced?", group: "recon" },
      {
        id: "cluster",
        kind: "processing",
        label: "🧭 Assign Flow A's gaps\n+ enqueue provider reshape job",
        group: "recon"
      },
      {
        id: "draft",
        kind: "processing",
        label: "📦 Enqueue provider draft jobs\nfor uncovered clusters",
        group: "recon"
      },
      {
        id: "outbox",
        kind: "processing",
        label: "📦 Drain Flow A's outbox\n+ enqueue GitHub jobs",
        group: "recon"
      },
      { id: "resolve", kind: "processing", label: "✅ Resolve gaps\n+ Re-index KB" },
      { id: "reject", kind: "user", label: "🚫 Mark rejected\n+ freeze cluster" },
      { id: "githubworker", kind: "user", label: "🔧 GitHub watcher\npushes branch + opens PR" }
    ],
    edges: [
      { from: "sched", to: "fa", label: "fan out: jobs per flow" },
      { from: "sched", to: "fb", label: "fan out: jobs per flow" },
      { from: "fa", to: "fb", label: "independent — neither can block the other", dashed: true },
      { from: "fa", to: "gather" },
      { from: "fa", to: "readpr" },
      { from: "gather", to: "poll" },
      { from: "poll", to: "write" },
      { from: "readpr", to: "gate" },
      { from: "gate", to: "outbox", label: "unchanged" },
      { from: "gate", to: "cluster", label: "advanced" },
      { from: "cluster", to: "draft" },
      { from: "draft", to: "outbox" },
      { from: "write", to: "readpr", label: "snapshot", dashed: true },
      { from: "readpr", to: "resolve", label: "merged" },
      { from: "readpr", to: "reject", label: "closed" },
      { from: "outbox", to: "githubworker" },
      { from: "githubworker", to: "poll", label: "next fetch", dashed: true }
    ]
  };
}

export const FLOWS: FlowDef[] = [
  { key: "overview", title: "System Overview", build: overview },
  { key: "ask", title: "Ask a Question", build: ask },
  { key: "improvement", title: "Improve the Docs", build: improvement },
  { key: "automation", title: "Scheduled Maintenance", build: automation },
  { key: "reconcile", title: "Reconcile Gate", build: reconcile },
  { key: "gappr", title: "Gap-to-PR Pipeline", build: gappr },
  { key: "perflow", title: "Per-Flow Isolation", build: perflow }
];

function flowsByKey(keys: FlowKey[]): FlowDef[] {
  return keys.map((key) => {
    const flow = FLOWS.find((candidate) => candidate.key === key);
    if (!flow) {
      throw new Error(`Unknown flow in navigation group: ${key}`);
    }
    return flow;
  });
}

export const FLOW_GROUPS: FlowGroupDef[] = [
  { title: "Start here", flows: flowsByKey(["overview"]) },
  { title: "Common workflows", flows: flowsByKey(["ask", "improvement", "automation"]) },
  { title: "Deep dives", flows: flowsByKey(["reconcile", "gappr", "perflow"]) }
];

export function buildFlowGraph(key: FlowKey, modelInfo: ModelInfo): FlowGraph {
  const flow = FLOWS.find((candidate) => candidate.key === key);
  if (!flow) {
    throw new Error(`Unknown flow: ${key}`);
  }
  return flow.build(modelInfo);
}
