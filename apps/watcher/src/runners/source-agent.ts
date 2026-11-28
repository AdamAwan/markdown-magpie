import { generateText, stepCountIs, tool, type FinishReason, type LanguageModel, type ModelMessage } from "ai";
import { ProviderOutputTruncatedError } from "@magpie/retrieval";
import { z } from "zod";
import { aiUsageFromTokenCounts, type AiUsage, type SourceMapEntry } from "@magpie/core";
import type { JobView, UndeclaredOutputFieldPolicy } from "@magpie/jobs";
import { JOB_RUNNER_SYSTEM, wrapUntrusted } from "@magpie/prompts";
import { UrlFetcher, type FetchableInternetSource } from "../fetch-url.js";
import { DEFAULT_UNDECLARED_OUTPUT_FIELDS, buildSourceGroundedPrompt, parseJobOutput } from "../job-prompts.js";
import { logger } from "../logger.js";
import { grepWorkspaces, listDir, readFile, SourceToolError, type ToolBudget } from "../source-tools.js";
import type { SourceWorkspace } from "../source-workspace.js";

const MAX_STEPS = 24;
const TOTAL_READ_BUDGET_BYTES = 400_000;
// Mirrors the CLI runner's agentic default; production passes
// MAGPIE_AGENTIC_TIMEOUT_MS through ChatRunnerOptions.agenticTimeoutMs.
const DEFAULT_AGENTIC_TIMEOUT_MS = 600_000;

interface SourceAgentOptions {
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
  // See ChatRunnerOptions.undeclaredOutputFields. Strict when omitted.
  undeclaredOutputFields?: UndeclaredOutputFieldPolicy;
  // Overall wall-clock budget for the WHOLE loop — every step, every tool call
  // and the forced closing turn — so the step cap cannot multiply a per-call
  // timeout into an unbounded run (J84). MAGPIE_AGENTIC_TIMEOUT_MS in production.
  timeoutMs?: number;
}

// The HTTP-provider execution tier for source-grounded jobs: a bounded
// generateText tool loop over the read-only source tools. The CLI tier does not
// come through here — agent CLIs traverse the checkout natively (see cli.ts).
// Tool misuse (SourceToolError) is returned to the model as an error string so
// it can correct course; an infrastructure fault halts the loop and fails the job.
// Transient provider failures (429/5xx) are retried per step by the AI SDK
// itself (maxRetries 2, honouring Retry-After), inside the overall deadline.
export async function runSourceAgentJob(options: SourceAgentOptions): Promise<unknown> {
  const { job, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENTIC_TIMEOUT_MS;
  // A plain (ref'd) timer cleared on completion rather than AbortSignal.timeout,
  // whose unref'd timer neither keeps a pending run alive nor gets cleaned up.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException(`source-agent deadline of ${timeoutMs}ms reached`, "TimeoutError")),
    timeoutMs
  );
  const runSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    return await runLoop(options, runSignal);
  } catch (error) {
    // The deadline, not the caller, ended the run: say so plainly rather than
    // surfacing a bare AbortError / TimeoutError from wherever it landed.
    if (deadline.signal.aborted && !signal.aborted) {
      throw new Error(
        `${job.type}[${job.id}]: source-agent loop exceeded its ${timeoutMs}ms deadline (MAGPIE_AGENTIC_TIMEOUT_MS)`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// A step that stopped at the provider's output-token limit produced a prefix,
// not an answer (J83) — fail it distinctly instead of parsing it (or forcing a
// closing turn that would be cut off the same way).
function assertNotTruncated(finishReason: FinishReason): void {
  if (finishReason === "length") {
    throw new ProviderOutputTruncatedError("Source-agent model", 'finishReason "length"');
  }
}

async function runLoop(options: SourceAgentOptions, runSignal: AbortSignal): Promise<unknown> {
  const { job, model, workspaces, notes, mapEntries = [], fetchable = [], onUsage } = options;
  const undeclaredOutputFields = options.undeclaredOutputFields ?? DEFAULT_UNDECLARED_OUTPUT_FIELDS;
  // The AI SDK types every totalUsage field as possibly-undefined (NaN shows up
  // for providers that don't report); the shared core sanitizer validates and
  // rounds each count independently.
  const reportUsage = (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void => {
    const mapped = aiUsageFromTokenCounts(usage);
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
  // File and web content the agent reads is untrusted reference material (#291):
  // wrap successful results in the shared delimiters so an injected directive in a
  // source file or fetched page is bounded as data, per the untrusted-content
  // contract in the job instructions. A SourceToolError still surfaces as a plain
  // "ERROR: …" string (wrapUntrusted never runs when the read throws), so the
  // model's misuse-correction contract is unchanged.
  const asContent = (run: () => Promise<string>): Promise<string> =>
    asToolResult(async () => wrapUntrusted(await run()));

  // Filesystem tools only when there is a workspace to explore, fetch_url only
  // when the operator allowlisted an internet source (#242) — a job grounded in
  // internet sources alone gets a fetch-only toolset rather than dead fs tools.
  const fetcher = fetchable.length > 0 ? new UrlFetcher(fetchable, budget, { signal: runSignal }) : undefined;
  const fsTools = {
    list_dir: tool({
      description: 'List a directory. Path is "<sourceId>/<relative path>"; pass "" to list the available sources.',
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path: requested }) => asToolResult(() => listDir(workspaces, requested))
    }),
    read_file: tool({
      description:
        'Read a text file. Path is "<sourceId>/<relative path>". Large files are returned in 32KB slices; re-call with offset to continue.',
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional() }),
      execute: ({ path: requested, offset }) => asContent(() => readFile(workspaces, requested, budget, offset ?? 0))
    }),
    grep: tool({
      description:
        'Search file contents across all sources for a literal, case-insensitive text string (not a regular expression). Optional glob filters paths (e.g. "s1/docs/**").',
      inputSchema: z.object({ query: z.string(), glob: z.string().optional() }),
      execute: ({ query, glob }) =>
        asContent(() => grepWorkspaces(workspaces, query, glob, { budget, signal: runSignal }))
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
            execute: ({ url, offset }) => asContent(() => fetcher.fetch(url, offset ?? 0))
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
    abortSignal: runSignal
  });
  // Report usage before the infra-fault check so the reading isn't skipped on
  // the throw below. NOTE: usage only reaches the API on a COMPLETED job (the
  // fail path carries no usage channel), so when the fault rethrows this
  // reading is dropped with the run — failed runs are unmetered by design; the
  // Insights chart reads completed rows only.
  reportUsage(result.totalUsage);
  if (infraError !== undefined) {
    // An infrastructure fault occurred inside a tool; whatever text the loop
    // produced is ungrounded. Fail the job — never parse or force an answer.
    throw infraError;
  }
  assertNotTruncated(result.finishReason);
  logger.debug(
    { jobId: job.id, steps: result.steps.length, budgetLeft: budget.remainingBytes },
    `${job.type}[${job.id}]: source-agent loop finished in ${result.steps.length} step(s)`
  );

  try {
    return parseJobOutput(job, result.text, undeclaredOutputFields);
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
    const forced = await generateText({
      model,
      system: JOB_RUNNER_SYSTEM.instructions,
      messages,
      abortSignal: runSignal
    });
    reportUsage(forced.totalUsage);
    assertNotTruncated(forced.finishReason);
    return parseJobOutput(job, forced.text, undeclaredOutputFields);
  }
}
