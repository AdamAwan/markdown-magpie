/**
 * Task 14 — end-to-end queue-lifecycle smoke test.
 *
 * Drives the live stack (API + watcher + pg-boss + Postgres + the OpenAI-compatible
 * chat fixture) through the four queue scenarios:
 *
 *   1. Happy path     — POST /api/ask, wait for completion, validate the answer
 *                       envelope {result,executor} and the answer fields.
 *   2. Cancel         — POST a [slow] ask, cancel the job mid-flight, assert
 *                       state === "cancelled".
 *   3. Retry -> fail  — POST a [fail] ask, observe retryCount climb, assert the
 *                       job eventually reaches terminal state "failed".
 *   4. Listing        — GET /api/jobs and /api/jobs/schedules, assert the created
 *                       job ids and reconciled schedule keys are visible.
 *
 * Polling is bounded; the script prints a clear PASS/FAIL line per scenario and
 * exits non-zero if any scenario fails.
 */

const API_BASE = (process.env.E2E_API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const API_TOKEN = process.env.E2E_API_TOKEN;

type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed" | "blocked";

interface JobView {
  id: string;
  type: string;
  state: JobState;
  retryCount: number;
  retryLimit: number;
  output?: { result?: unknown; executor?: string };
  error?: { message?: string; code?: string };
}

interface AskResponse {
  questionId: string;
  job: JobView;
  links: { question: string; job: string; wait: string; cancel: string };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (API_TOKEN) h.authorization = `Bearer ${API_TOKEN}`;
  return h;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ask(question: string): Promise<AskResponse> {
  return http<AskResponse>("/api/ask", { method: "POST", body: JSON.stringify({ question }) });
}

async function getJob(id: string): Promise<JobView> {
  const { job } = await http<{ job: JobView }>(`/api/jobs/${id}`);
  return job;
}

const TERMINAL: ReadonlySet<JobState> = new Set(["completed", "cancelled", "failed"]);

// Polls a job until `predicate` is true or the deadline elapses. Returns the last
// job view seen.
async function pollJob(
  id: string,
  predicate: (job: JobView) => boolean,
  { timeoutMs, pollMs = 500, label }: { timeoutMs: number; pollMs?: number; label: string }
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  let job = await getJob(id);
  while (!predicate(job)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label} (last state=${job.state}, retryCount=${job.retryCount})`);
    }
    await sleep(pollMs);
    job = await getJob(id);
  }
  return job;
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

// Scenario 1: happy-path answer.
async function scenarioHappyPath(): Promise<string> {
  const name = "1. happy-path answer";
  const created = await ask("What does the documentation cover?");
  const jobId = created.job.id;
  console.log(`  created answer job ${jobId} (question ${created.questionId})`);
  const job = await pollJob(jobId, (j) => TERMINAL.has(j.state), {
    timeoutMs: 60_000,
    label: "happy-path completion"
  });
  if (job.state !== "completed") {
    record(name, false, `expected completed, got ${job.state} (${job.error?.message ?? "no error"})`);
    return jobId;
  }
  const result = job.output?.result as { answer?: unknown; confidence?: unknown; citations?: unknown } | undefined;
  const hasEnvelope = job.output !== undefined && typeof job.output.executor === "string";
  const hasAnswer = typeof result?.answer === "string" && (result.answer as string).length > 0;
  const hasConfidence = typeof result?.confidence === "string";
  const hasCitations = Array.isArray(result?.citations);
  const ok = hasEnvelope && hasAnswer && hasConfidence && hasCitations;
  record(
    name,
    ok,
    ok
      ? `completed; executor=${job.output?.executor}, answer present, confidence=${String(result?.confidence)}, citations=${(result?.citations as unknown[]).length}`
      : `envelope/answer validation failed (envelope=${hasEnvelope}, answer=${hasAnswer}, confidence=${hasConfidence}, citations=${hasCitations})`
  );
  return jobId;
}

// Scenario 2: cancel a slow job mid-flight.
async function scenarioCancel(): Promise<string> {
  const name = "2. cancel in-flight";
  const created = await ask("[slow] Tell me everything about the documentation");
  const jobId = created.job.id;
  console.log(`  created slow answer job ${jobId}`);
  // Wait until the watcher has picked it up (active), so the cancel lands on an
  // in-flight job rather than a queued one.
  try {
    await pollJob(jobId, (j) => j.state === "active" || TERMINAL.has(j.state), {
      timeoutMs: 30_000,
      pollMs: 300,
      label: "slow job to become active"
    });
  } catch (error) {
    record(name, false, `job never became active: ${(error as Error).message}`);
    return jobId;
  }
  await http(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  const job = await pollJob(jobId, (j) => j.state === "cancelled" || TERMINAL.has(j.state), {
    timeoutMs: 20_000,
    label: "cancellation"
  });
  const ok = job.state === "cancelled";
  record(name, ok, ok ? "job state=cancelled" : `expected cancelled, got ${job.state}`);
  return jobId;
}

// Scenario 3: a [fail] job retries then permanently fails.
async function scenarioRetryFail(): Promise<string> {
  const name = "3. retry then permanent fail";
  const created = await ask("[fail] What does the documentation cover?");
  const jobId = created.job.id;
  console.log(`  created failing answer job ${jobId} (retryLimit=${created.job.retryLimit})`);
  // Observe at least one retry (retryCount > 0) as evidence of the retry path.
  let sawRetry = false;
  try {
    const mid = await pollJob(jobId, (j) => j.retryCount > 0 || j.state === "failed", {
      timeoutMs: 90_000,
      pollMs: 1_000,
      label: "first retry"
    });
    sawRetry = mid.retryCount > 0;
    console.log(`  observed retryCount=${mid.retryCount} (state=${mid.state})`);
  } catch (error) {
    console.log(`  warning: did not observe retryCount climb: ${(error as Error).message}`);
  }
  const job = await pollJob(jobId, (j) => j.state === "failed" || j.state === "completed", {
    timeoutMs: 180_000,
    pollMs: 2_000,
    label: "permanent failure"
  });
  const ok = job.state === "failed" && sawRetry;
  record(
    name,
    ok,
    job.state === "failed"
      ? `terminal state=failed, retryCount=${job.retryCount}/${job.retryLimit}, sawRetry=${sawRetry}, error=${job.error?.message ?? "n/a"}`
      : `expected failed, got ${job.state}`
  );
  return jobId;
}

// Scenario 4: listing jobs and schedules.
async function scenarioListing(createdJobIds: string[]): Promise<void> {
  const name = "4. listing jobs + schedules";
  const { jobs, total } = await http<{ jobs: JobView[]; total: number }>("/api/jobs?limit=200");
  const listedIds = new Set(jobs.map((j) => j.id));
  const allVisible = createdJobIds.every((id) => listedIds.has(id));

  // Schedules are reconciled from saved product settings, so a clean DB starts
  // with none. Seed one real schedule (enable a scheduled task via its settings
  // endpoint, which reconciles into pg-boss) so this scenario genuinely exercises
  // the reconciled-schedule-key path rather than assuming pre-seeded schedules.
  const tasks = await http<{ tasks: Array<{ key: string }> }>("/api/scheduled-tasks");
  const seedKey = tasks.tasks[0]?.key;
  let expectedScheduleKey: string | undefined;
  if (seedKey) {
    await http(`/api/scheduled-tasks/${encodeURIComponent(seedKey)}/settings`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, cron: "*/30 * * * *" })
    });
    expectedScheduleKey = `task:${seedKey}`;
  }

  const { schedules } = await http<{ schedules: Array<{ key: string; type: string; cron: string }> }>(
    "/api/jobs/schedules"
  );
  const scheduleKeys = schedules.map((s) => s.key);
  const seededVisible = expectedScheduleKey ? scheduleKeys.includes(expectedScheduleKey) : false;

  const ok = allVisible && seededVisible;
  record(
    name,
    ok,
    `jobs listed: ${jobs.length}/${total} (all created visible=${allVisible}); seeded schedule key ${expectedScheduleKey ?? "(none)"} visible=${seededVisible}; schedules: [${scheduleKeys.join(", ")}]`
  );
}

async function main(): Promise<void> {
  console.log(`E2E target API: ${API_BASE}`);
  // Wait for the API to be healthy before starting.
  await pollHealth();

  const createdIds: string[] = [];
  createdIds.push(await scenarioHappyPath());
  createdIds.push(await scenarioCancel());
  createdIds.push(await scenarioRetryFail());
  await scenarioListing(createdIds);

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== E2E summary ===");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll scenarios passed.");
}

async function pollHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1_000);
  }
  throw new Error("API did not become healthy within 60s");
}

main().catch((error) => {
  console.error("E2E harness error:", error);
  process.exit(1);
});
