import type { ChatProvider } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import { answerQuestionInputSchema, reconcileGapClustersInputSchema, reconcileGapClustersOutputSchema } from "@magpie/jobs";
import { ANSWER_QUESTION, GAP_RECONCILE_CRITIC, GAP_RECONCILE_PROPOSE, withPersona } from "@magpie/prompts";
import { routeQuestionToFlow, type RoutableFlow } from "@magpie/retrieval";
import type { z } from "zod";
import type { WatcherApi } from "../http-client.js";
import { buildAnswerOutput, buildPrompt, parseJobOutput } from "../job-prompts.js";

// The AI job types a hosted chat provider can execute. Publication (github) and
// maintenance jobs are handled by other runners.
const CHAT_JOB_TYPES: ReadonlySet<JobType> = new Set([
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "fold_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "cluster_gap_candidates",
  "reconcile_gap_clusters",
  "sync_source_changes_generate_plan",
  "verify_document"
]);

type ReconcileOutput = z.infer<typeof reconcileGapClustersOutputSchema>;
type ProposedMerge = { clusterIds: string[]; rationale: string };
type ProposedSplit = { clusterId: string; children: Array<{ gapIds: string[] }>; rationale: string };

// Runs AI jobs through an OpenAI-compatible or Azure OpenAI chat provider. The
// capability (openai-compatible / azure-openai) is whatever queue the watcher
// claimed from, so the API has already matched provider to runner.
//
// answer_question is special: routing and retrieval happen here in the watcher
// (route -> retrieve -> answer), and citations are derived from the retrieved
// sections rather than trusted from the model.
export class ChatRunner {
  constructor(
    readonly capability: Extract<JobCapability, "openai-compatible" | "azure-openai">,
    private readonly chat: ChatProvider,
    private readonly api: WatcherApi
  ) {}

  supports(type: JobType): boolean {
    return CHAT_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    if (job.type === "answer_question") {
      return this.answer(job, signal);
    }
    if (job.type === "reconcile_gap_clusters") {
      return this.reconcileGapClusters(job, signal);
    }

    const response = await this.chat.complete({
      system: ANSWER_QUESTION.instructions,
      messages: [{ role: "user", content: buildPrompt(job) }],
      signal
    });
    return parseJobOutput(job, response.content);
  }

  private async answer(job: JobView, signal: AbortSignal): Promise<unknown> {
    const input = answerQuestionInputSchema.parse(job.input);
    const flows: RoutableFlow[] = input.flows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      ...(flow.persona ? { persona: flow.persona } : {})
    }));

    // 1. Route the question to the best-matching flow (a generative call). When
    //    routing degrades (no flows, provider error), flowId stays undefined and
    //    retrieval runs unscoped.
    console.log(`answer_question[${job.id}]: routing question across ${flows.length} flow(s)`);
    const decision = await routeQuestionToFlow(input.question, flows, this.chat);
    const flowId = decision?.flowId;
    const routedFlow = flowId ? flows.find((flow) => flow.id === flowId) : undefined;

    // 2. Retrieve the scoped sections from the API (the watcher cannot reach
    //    pgvector itself).
    console.log(`answer_question[${job.id}]: retrieving sections for flow ${flowId ?? "(unscoped)"}`);
    const sections = await this.api.retrieve(input.question, flowId, undefined);

    // 3. Answer using those sections, applying the routed flow's persona.
    console.log(`answer_question[${job.id}]: generating answer from ${sections.length} section(s)`);
    const context = sections.map((section) => `# ${section.heading}\n${section.content}`).join("\n\n");
    const response = await this.chat.complete({
      system: withPersona(ANSWER_QUESTION.instructions, routedFlow?.persona),
      messages: [{ role: "user", content: `Question:\n${input.question}\n\nContext:\n${context}` }],
      signal
    });

    // 4. Build the output, deriving citations from the retrieved sections and
    //    recording the routed flow.
    return buildAnswerOutput(response.content, sections, input.question, flowId);
  }

  // reconcile_gap_clusters is special: a two-call generative flow that mirrors the
  // reshape step the API gap reconciler used to run in-process. First propose
  // merges/splits over the active clusters, then critic-confirm each proposed
  // change individually. The critic's verdict — never the propose payload — sets
  // `confirmed`, so a proposal can never confirm itself.
  private async reconcileGapClusters(job: JobView, signal: AbortSignal): Promise<ReconcileOutput> {
    const input = reconcileGapClustersInputSchema.parse(job.input);

    const summary = input.clusters
      .map((cluster) => `cluster ${cluster.id} (flow ${cluster.flowId ?? "none"}): ${cluster.title}`)
      .join("\n");
    console.log(`reconcile_gap_clusters[${job.id}]: proposing reshape over ${input.clusters.length} cluster(s)`);
    const proposeResponse = await this.chat.complete({
      system: GAP_RECONCILE_PROPOSE.instructions,
      messages: [{ role: "user", content: summary }],
      signal
    });
    const proposal = parseReshape(proposeResponse.content);

    console.log(
      `reconcile_gap_clusters[${job.id}]: critic-confirming ${proposal.merges.length} merge(s), ${proposal.splits.length} split(s)`
    );
    const merges: ReconcileOutput["merges"] = [];
    for (const merge of proposal.merges) {
      const confirmed = await this.criticConfirm("merge", merge.rationale, signal);
      merges.push({ clusterIds: merge.clusterIds, rationale: merge.rationale, confirmed });
    }
    const splits: ReconcileOutput["splits"] = [];
    for (const split of proposal.splits) {
      const confirmed = await this.criticConfirm("split", split.rationale, signal);
      splits.push({ clusterId: split.clusterId, children: split.children, rationale: split.rationale, confirmed });
    }

    return reconcileGapClustersOutputSchema.parse({ merges, splits });
  }

  // Asks the critic to confirm a single proposed merge/split. Parsing is defensive:
  // an unparseable verdict ⇒ not confirmed (matching the old in-API behaviour).
  private async criticConfirm(kind: "merge" | "split", rationale: string, signal: AbortSignal): Promise<boolean> {
    const response = await this.chat.complete({
      system: GAP_RECONCILE_CRITIC.instructions,
      messages: [{ role: "user", content: `Proposed ${kind}. Rationale: ${rationale}` }],
      signal
    });
    try {
      const parsed = JSON.parse(response.content) as { confirmed?: unknown };
      return parsed.confirmed === true;
    } catch {
      return false;
    }
  }
}

// Parses the propose payload defensively: a malformed response yields no reshape
// (an empty propose set), so the reconciler simply applies nothing this run.
function parseReshape(content: string): { merges: ProposedMerge[]; splits: ProposedSplit[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { merges: [], splits: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { merges: [], splits: [] };
  }
  const candidate = parsed as { merges?: unknown; splits?: unknown };
  return {
    merges: Array.isArray(candidate.merges) ? candidate.merges.filter(isProposedMerge) : [],
    splits: Array.isArray(candidate.splits) ? candidate.splits.filter(isProposedSplit) : []
  };
}

function isProposedMerge(value: unknown): value is ProposedMerge {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterIds?: unknown; rationale?: unknown };
  return (
    Array.isArray(candidate.clusterIds) &&
    candidate.clusterIds.every((id) => typeof id === "string") &&
    typeof candidate.rationale === "string"
  );
}

function isProposedSplit(value: unknown): value is ProposedSplit {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { clusterId?: unknown; children?: unknown; rationale?: unknown };
  return (
    typeof candidate.clusterId === "string" &&
    typeof candidate.rationale === "string" &&
    Array.isArray(candidate.children) &&
    candidate.children.every(
      (child) =>
        Boolean(child) &&
        typeof child === "object" &&
        Array.isArray((child as { gapIds?: unknown }).gapIds) &&
        (child as { gapIds: unknown[] }).gapIds.every((id) => typeof id === "string")
    )
  );
}
