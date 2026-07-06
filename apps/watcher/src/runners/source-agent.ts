import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import type { JobView } from "@magpie/jobs";
import { JOB_RUNNER_SYSTEM } from "@magpie/prompts";
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

const MAX_STEPS = 24;
const TOTAL_READ_BUDGET_BYTES = 400_000;

// The HTTP-provider execution tier for source-grounded jobs: a bounded
// generateText tool loop over the read-only source tools. The CLI tier does not
// come through here — agent CLIs traverse the checkout natively (see cli.ts).
// Tool failures are returned to the model as error strings so it can correct
// course; only infrastructure failures reject.
export async function runSourceAgentJob(options: {
  job: JobView;
  model: LanguageModel;
  workspaces: SourceWorkspace[];
  notes: string[];
  signal: AbortSignal;
}): Promise<unknown> {
  const { job, model, workspaces, notes, signal } = options;
  const budget: ToolBudget = { remainingBytes: TOTAL_READ_BUDGET_BYTES };
  // SourceToolError is the tools' whole misuse contract (bad path, budget, binary
  // file…) — render it for the model. Anything else is an infrastructure fault and
  // rethrows to fail the job.
  const asToolResult = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SourceToolError) {
        return `ERROR: ${error.message}`;
      }
      throw error;
    }
  };

  const tools = {
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

  const prompt = buildSourceGroundedPrompt(job, workspaces, notes, "tools");
  const result = await generateText({
    model,
    system: JOB_RUNNER_SYSTEM.instructions,
    prompt,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: signal
  });
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
    return parseJobOutput(job, forced.text);
  }
}
