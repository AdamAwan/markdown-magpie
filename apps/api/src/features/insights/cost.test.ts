import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiUsageBreakdown } from "@magpie/core";
import { summariseAiCost } from "./cost.js";

test("summariseAiCost sums tokens and keeps the three cost states distinct", () => {
  const rows: AiUsageBreakdown[] = [
    // priced: contributes cost and its metered jobs to pricedJobs.
    {
      jobType: "improve_document",
      provider: "openai-compatible",
      model: "gpt-4o",
      jobs: 3,
      jobsWithUsage: 3,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      estimatedCost: 0.5
    },
    // unpriced: usage reported but no cost — must NOT count toward pricedJobs.
    {
      jobType: "improve_document",
      provider: "openai-compatible",
      model: "gpt-4o-mini",
      jobs: 2,
      jobsWithUsage: 2,
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50
    },
    // unmetered: no usage at all.
    {
      jobType: "verify_document",
      provider: "claude",
      jobs: 4,
      jobsWithUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  ];

  assert.deepEqual(summariseAiCost(rows), {
    jobs: 9,
    jobsWithUsage: 5,
    pricedJobs: 3,
    inputTokens: 140,
    outputTokens: 30,
    totalTokens: 170,
    estimatedCost: 0.5
  });
});

test("summariseAiCost omits estimatedCost when nothing is priced", () => {
  const rows: AiUsageBreakdown[] = [
    {
      jobType: "verify_document",
      provider: "claude",
      jobs: 2,
      jobsWithUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  ];
  const summary = summariseAiCost(rows);
  assert.equal(summary.estimatedCost, undefined);
  assert.equal(summary.pricedJobs, 0);
  assert.equal(summary.jobs, 2);
});

test("summariseAiCost of no rows is an all-zero summary with no cost", () => {
  assert.deepEqual(summariseAiCost([]), {
    jobs: 0,
    jobsWithUsage: 0,
    pricedJobs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  });
});
