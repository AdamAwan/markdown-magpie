import type { AiUsage, ChatProvider } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import type { LanguageModel } from "ai";
import type { WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import { fetchSourceMapEntries, hasFetchableSources, hasFsSources, prepareSourceWorkspaces, sourceDescriptorsOf, stampSourceMapUpdates } from "../source-workspace.js";
import { withUsageReporting } from "../usage.js";
import { PROVIDER_JOB_TYPES, runGenerativeJob } from "./generative.js";
import { runSourceAgentJob } from "./source-agent.js";

// Runs AI jobs through an OpenAI-compatible or Azure OpenAI chat provider. The
// capability (openai-compatible / azure-openai) is whatever queue the watcher
// claimed from, so the API has already matched provider to runner. Source-grounded
// jobs with filesystem-backed sources run the agentic tool loop over their source
// workspaces; everything else runs the one-shot generative path.
export class ChatRunner {
  constructor(
    readonly capability: Extract<JobCapability, "openai-compatible" | "azure-openai">,
    private readonly chat: ChatProvider,
    private readonly api: WatcherApi,
    private readonly agentModel?: LanguageModel,
    private readonly checkoutRoot: string = process.env.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts",
    private readonly prepareWorkspaces: typeof prepareSourceWorkspaces = prepareSourceWorkspaces
  ) {}

  supports(type: JobType): boolean {
    return PROVIDER_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal, onUsage?: (usage: AiUsage) => void): Promise<unknown> {
    const descriptors = sourceDescriptorsOf(job);
    // The agent loop runs whenever there is anything real to ground in: a
    // filesystem workspace, or an operator-allowlisted internet source (#242) —
    // a job with only fetchable internet sources gets a fetch_url-only toolset.
    if (hasFsSources(descriptors) || hasFetchableSources(descriptors)) {
      if (this.agentModel) {
        const { workspaces, notes, fetchable } = await this.prepareWorkspaces(descriptors, { checkoutRoot: this.checkoutRoot });
        logger.info(
          { jobId: job.id, workspaceCount: workspaces.length, fetchableCount: fetchable.length },
          `${job.type}[${job.id}]: running source-agent loop over ${workspaces.length} workspace(s) and ${fetchable.length} fetchable internet source(s)`
        );
        const mapEntries = await fetchSourceMapEntries(this.api, workspaces);
        return stampSourceMapUpdates(
          await runSourceAgentJob({ job, model: this.agentModel, workspaces, notes, mapEntries, fetchable, signal, ...(onUsage ? { onUsage } : {}) }),
          workspaces
        );
      }
      logger.warn(
        { jobId: job.id },
        `${job.type}[${job.id}]: job has explorable sources but no agent model is configured — running un-grounded via the generative path`
      );
    }
    // Every provider call a generative run makes (routing, search rounds,
    // grounding verification, critic passes) reports through the same wrapper.
    const model = onUsage ? withUsageReporting(this.chat, onUsage) : this.chat;
    return runGenerativeJob({ job, model, api: this.api, signal });
  }
}
