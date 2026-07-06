import type { ChatProvider } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import type { LanguageModel } from "ai";
import type { WatcherApi } from "../http-client.js";
import { logger } from "../logger.js";
import { hasFsSources, prepareSourceWorkspaces, sourceDescriptorsOf } from "../source-workspace.js";
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

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    const descriptors = sourceDescriptorsOf(job);
    if (hasFsSources(descriptors) && this.agentModel) {
      const { workspaces, notes } = await this.prepareWorkspaces(descriptors, { checkoutRoot: this.checkoutRoot });
      logger.info(
        { jobId: job.id, workspaceCount: workspaces.length },
        `${job.type}[${job.id}]: running source-agent loop over ${workspaces.length} workspace(s)`
      );
      return runSourceAgentJob({ job, model: this.agentModel, workspaces, notes, signal });
    }
    return runGenerativeJob({ job, model: this.chat, api: this.api, signal });
  }
}
