import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import type { AiUsage, SourceMapEntry } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";
import { UrlFetcher, type FetchableInternetSource } from "../fetch-url.js";
import { buildSourceGroundedPrompt, parseJobOutput } from "../job-prompts.js";
import { logger } from "../logger.js";
import {
  grepWorkspaces,
  listDir,
  readFile,
  SourceToolError,
  type ToolBudget
} from "../source-tools.js";
import type { SourceWorkspace } from "../source-workspace.js";
import { usageFromLanguageModelUsage } from "../usage.js";

const MAX_STEPS = 24;
const TOTAL_READ_BUDGET_BYTES = 400_000;

// The HTTP-provider execution tier for source-grounded jobs: a bounded
// generateText tool loop over the read-only source tools. The CLI tier does not
// come through here — agent CLIs traverse the checkout natively (see cli.ts).
// Tool misuse (SourceToolError) is returned to the model as an error string so
// it can correct course; an infrastructure fault halts the loop and fails the job.
export async function runSourceAgentJob(options: {
  job: JobView;
  model: LanguageModel;
  workspaces: SourceWorkspace[];
  notes: string[];
  mapEntries?: SourceMapEntry[];
  // Operator-allowlisted internet sources (#242); presence adds the fetch_url
  // tool, sharing the same read budget as the filesystem tools.
  fetchable?: FetchableInternetSource[];
  signal: AbortSignal;
  // Receives the loop's provider-reported token usage (#241) — the aggregate
  // across every step, plus the forced closing turn when one runs.
  onUsage?: (usage: AiUsage) => void;
}): Promise<unknown> {
  const { job, model, workspaces, notes, mapEntries = [], fetchable = [], signal, onUsage } = options;
  const reportUsage = (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void => {
    const mapped = usageFromLanguageModelUsage(usage);
    if (mapped && onUsage) {
      onUsage(mapped);
    }
  };
  const budget: ToolBudget = { remainingBytes: TOTAL_READ_BUDGET_BYTES };
  // SourceToolError is the tools' whole misuse contract (bad path, budget, binary
  // file…) — render it for the model. Anything else is an infrastructure fault
  // that must fail the job. A plain rethrow cannot do that: generateText catches
  // every throw from a tool's execute and renders it to the model as a tool-error
  // part, so the job would resolve with an ungrounded draft (and leak raw host
  // paths to the provider). Instead the first infra fault is recorded here, a stop
  // condition below halts the loop before the model gets another turn, and the
  // fault is rethrown once generateText returns.
  let infraError: unknown;
  const asToolResult = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SourceToolError) {
        return `ERROR: ${error.message}`;
      }
      infraError ??= error;
      throw error;
    }
  };

  // Filesystem tools only when there is a workspace to explore, fetch_url only
  // when the operator allowlisted an internet source (#242) — a job grounded in
  // internet sources alone gets a fetch-only toolset rather than dead fs tools.
  const fetcher = fetchable.length > 0 ? new UrlFetcher(fetchable, budget, { signal }) : undefined;
  const fsTools = {
    list_dir: tool({
      description:
        'List a directory. Path is "<sourceId>/<relative path>"; pass "" to list the available sources.',
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path: requested }) => asToolResult(() => listDir(workspaces, requested))
    }),
    read_file: tool({
      description:
        'Read a text file. Path is "<sourceId>/<relative path>". Large files are returned in 32KB slices; re-call with offset to continue.',
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional() }),
      execute: ({ path: requested, offset }) => asToolResult(() => readFile(workspaces, requested, budget, offset ?? 0))
    }),
    grep: tool({
      description:
        'Search file contents across all sources for a literal, case-insensitive text string (not a regular expression). Optional glob filters paths (e.g. "s1/docs/**").',
      inputSchema: z.object({ query: z.string(), glob: z.string().optional() }),
      execute: ({ query, glob }) => asToolResult(() => grepWorkspaces(workspaces, query, glob))
    })
  };
  const tools = {
    ...(workspaces.length > 0 ? fsTools : {}),
    ...(fetcher
      ? {
          fetch_url: tool({
            description:
              "Fetch an allowlisted internet source page over https and return its readable text. Long pages are returned in 32KB slices; re-call with offset to continue.",
            inputSchema: z.object({ url: z.string(), offset: z.number().int().min(0).optional() }),
            execute: ({ url, offset }) => asToolResult(() => fetcher.fetch(url, offset ?? 0))
          })
        }
      : {})
  };

  const prompt = buildSourceGroundedPrompt(job, workspaces, notes, "tools", mapEntries, fetchable);
  const result = await generateText({
    model,
    system: JOB_RUNNER_SYSTEM.instructions,
    prompt,
    tools,
    stopWhen: [stepCountIs(MAX_STEPS), () => infraError !== undefined],
    abortSignal: signal
  });
  // Report usage before the infra-fault check: the tokens were spent either way.
  reportUsage(result.totalUsage);
  if (infraError !== undefined) {
    // An infrastructure fault occurred inside a tool; whatever text the loop
    // produced is ungrounded. Fail the job — never parse or force an answer.
    throw infraError;
  }
  logger.debug(
    { jobId: job.id, steps: result.steps.length, budgetLeft: budget.remainingBytes },
    `${job.type}[${job.id}]: source-agent loop finished in ${result.steps.length} step(s)`
  );

  try {
    return parseJobOutput(job, result.text);
  } catch (error) {
    // The loop hit the step cap mid-exploration (or replied with prose). One
    // forced, tool-less closing turn — the same convergence guarantee the answer
    // loop's forceAnswer gives. responseMessages carries EVERY step's assistant
    // and tool turns (result.response.messages holds only the final step's).
    logger.warn(
      { jobId: job.id, err: error instanceof Error ? error.message : String(error) },
      `${job.type}[${job.id}]: forcing final answer after loop output did not parse`
    );
    const messages: ModelMessage[] = [
      { role: "user", content: prompt },
      ...result.responseMessages,
      {
        role: "user",
        content:
          "You have gathered enough. Produce the FINAL JSON output now, exactly matching the required shape. JSON only — no prose, no further exploration."
      }
    ];
    const forced = await generateText({ model, system: JOB_RUNNER_SYSTEM.instructions, messages, abortSignal: signal });
    reportUsage(forced.totalUsage);
    return parseJobOutput(job, forced.text);
  }
}
