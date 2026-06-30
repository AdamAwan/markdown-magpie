import type { ChatProvider } from "@magpie/core";
import type { JobCapability, JobType, JobView } from "@magpie/jobs";
import type { WatcherApi } from "../http-client.js";
import { PROVIDER_JOB_TYPES, runGenerativeJob } from "./generative.js";

// Runs AI jobs through an OpenAI-compatible or Azure OpenAI chat provider. The
// capability (openai-compatible / azure-openai) is whatever queue the watcher
// claimed from, so the API has already matched provider to runner.
export class ChatRunner {
  constructor(
    readonly capability: Extract<JobCapability, "openai-compatible" | "azure-openai">,
    private readonly chat: ChatProvider,
    private readonly api: WatcherApi
  ) {}

  supports(type: JobType): boolean {
    return PROVIDER_JOB_TYPES.has(type);
  }

  async run(job: JobView, signal: AbortSignal): Promise<unknown> {
    return runGenerativeJob({ job, model: this.chat, api: this.api, signal });
  }
}
