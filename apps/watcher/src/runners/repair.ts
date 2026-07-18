import type { ChatProvider } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import { REPAIR_OUTPUT, wrapUntrusted } from "@magpie/prompts";
import { parseJobOutput } from "../job-prompts.js";
import { logger } from "../logger.js";

export interface RepairRepromptOptions {
  // The re-claimed job, whose `repair` context is present (the caller checks).
  job: JobView;
  // The runner's own single-shot completion primitive (the hosted chat provider,
  // or the CLI adapted to the same complete() contract). Repair is deliberately
  // ONE completion — no retrieval, no agent loop.
  model: ChatProvider;
  signal: AbortSignal;
}

// Single-shot reshape of a schema-invalid prior output (#288d). Exactly one model
// call: the prior output + the exact Zod contract violations + the REPAIR_OUTPUT
// contract-reminder prompt, then the reply parsed against the job's OWN output
// contract via parseJobOutput. NO retrieval, NO agent loop, no side context — the
// only inputs are the prior output and the contract violations, so the reshape
// cannot fabricate grounded material (the API also enforces a per-type safety
// guard). An unparseable/still-invalid reshape throws, which the worker loop
// reports as a completion the API then terminal-fails.
export async function runRepairReprompt(options: RepairRepromptOptions): Promise<unknown> {
  const { job, model, signal } = options;
  const repair = job.repair;
  if (!repair) {
    // Defensive: callers gate on job.repair, so this never fires in practice.
    throw new Error(`runRepairReprompt called for job ${job.id} without repair context`);
  }

  const issuesBlock =
    repair.issues.length > 0
      ? repair.issues.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`).join("\n")
      : "- (no field paths reported; return JSON that satisfies the contract)";
  // The prior output is untrusted reference material (it is model-authored JSON),
  // so wrap it in the shared delimiters — the reshape must treat it as data.
  const priorJson = wrapUntrusted(JSON.stringify(repair.priorOutput ?? null, null, 2));

  logger.info(
    { jobId: job.id, jobType: job.type, issueCount: repair.issues.length, attempt: repair.attempt },
    `${job.type}[${job.id}]: running single-shot repair reshape over ${repair.issues.length} contract violation(s)`
  );

  const response = await model.complete({
    system: REPAIR_OUTPUT.instructions,
    messages: [
      {
        role: "user",
        content: `The JSON below failed its schema contract. Return corrected JSON that fixes every listed violation, changing only what is necessary and preserving all other fields — especially citations — verbatim.\n\nJSON produced:\n${priorJson}\n\nContract violations to fix (field path: message):\n${issuesBlock}`
      }
    ],
    responseFormat: "json",
    signal
  });

  // Parse against the job's own output contract (parseJobOutput uses extractJson
  // internally, tolerating a code fence/prose). A still-invalid reshape throws
  // here, which the API then terminal-fails.
  return parseJobOutput(job, response.content);
}
