/**
 * Golden-question regression eval (issue #241).
 *
 * Boots the whole answer pipeline self-contained — the deterministic golden
 * provider fixture, the API, and one watcher — against the throwaway Postgres
 * that scripts/test-db.mjs provides, indexes the golden fixture KB, asks every
 * case in scripts/fixtures/golden-questions.json through POST /api/ask, and
 * scores the stored question logs on routing accuracy, confidence calibration,
 * citation precision/recall, groundedness, answer content, and behaviour
 * compliance (gaps / out-of-scope / flow-selection / grounding verification).
 *
 * Scores are compared against the committed baseline
 * (scripts/fixtures/golden-baseline.json): any dimension below baseline, or a
 * case that passed at baseline time and fails now, fails the run loudly.
 * Improvements are reported; re-pin with --update-baseline. Every run also
 * appends its scores to .magpie/eval/golden-history.jsonl for tracking over
 * time.
 *
 * Run it:   npm run eval:golden                 (wraps this in test-db.mjs)
 * Re-pin:   npm run eval:golden -- --update-baseline
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, compareToBaseline, scoreCase } from "./lib/golden-scoring.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(rootDir, "scripts", "fixtures");
const kbDir = path.join(fixturesDir, "golden-kb");
const questionsPath = path.join(fixturesDir, "golden-questions.json");
const baselinePath = path.join(fixturesDir, "golden-baseline.json");
const evalStateDir = path.join(rootDir, ".magpie", "eval");
const historyPath = path.join(evalStateDir, "golden-history.jsonl");

const updateBaseline = process.argv.includes("--update-baseline");

const BOOT_TIMEOUT_MS = 90_000;
const CASE_TIMEOUT_MS = 90_000;
const POLL_MS = 300;

interface GoldenExpectation {
  routing: { mode: string; flowId?: string };
  confidence: string;
  citedDocs?: string[];
  answerContains?: string[];
  answerExcludes?: string[];
  gaps?: "none" | "some";
  outOfScope?: boolean;
  flowSelectionRequired?: boolean;
  verification?: string;
}

interface GoldenCase {
  id: string;
  question: string;
  flow?: string;
  expect: GoldenExpectation;
}

interface GoldenQuestionSet {
  version: number;
  cases: GoldenCase[];
}

interface CaseScore {
  id: string;
  passed: boolean;
  checks: Record<string, boolean | number | null>;
}

interface EvalResult {
  questionSetVersion: number;
  dimensions: Record<string, number>;
  cases: Record<string, boolean>;
}

const children: ChildProcess[] = [];

function launch(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: rootDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const logPath = path.join(evalStateDir, `${name}.log`);
  writeFileSync(logPath, "");
  const append = (chunk: Buffer) => appendFileSync(logPath, chunk);
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[eval] ${name} exited with code ${code} — see ${logPath}`);
    }
  });
  children.push(child);
  return child;
}

function stopChildren(): void {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("could not allocate a port")));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) {
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// A child env with every knob that could steer the pipeline stripped, so a
// developer's shell (real provider keys, embedding config, knowledge repos)
// can never change what the eval measures. DATABASE_URL comes from
// test-db.mjs and is kept.
function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const steering =
    /^(OPENAI_COMPATIBLE_|AZURE_OPENAI_|KNOWLEDGE_|WATCHER_|FLOW_ROUTER_|GAP_|AI_|AUTH_|MAGPIE_|EMBEDDING_|OTEL_|LOG_|PORT$|API_BASE_URL$|SOURCE)/;
  for (const key of Object.keys(env)) {
    if (steering.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${response.status}: ${text}`);
  }
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface AskResponse {
  questionId: string;
  job: { id: string };
  links: { question: string; wait: string };
}

async function askCase(apiBase: string, goldenCase: GoldenCase): Promise<unknown> {
  const { body: ask } = await httpJson<AskResponse>(`${apiBase}/api/ask`, {
    method: "POST",
    body: JSON.stringify({ question: goldenCase.question, ...(goldenCase.flow ? { flow: goldenCase.flow } : {}) })
  });

  const deadline = Date.now() + CASE_TIMEOUT_MS;
  let state: string | undefined;
  while (Date.now() < deadline) {
    const { status, body } = await httpJson<{ job: { state: string } }>(`${apiBase}${ask.links.wait}`);
    if (status === 200) {
      state = body.job.state;
      break;
    }
    await sleep(POLL_MS);
  }
  if (state === undefined) {
    throw new Error(`case ${goldenCase.id}: timed out waiting for job ${ask.job.id}`);
  }
  if (state !== "completed") {
    throw new Error(`case ${goldenCase.id}: job ${ask.job.id} ended in state '${state}'`);
  }
  // The completion dispatcher persists the job output first and updates the
  // question log as a side effect, so the stored answer can land moments after
  // the job reads as completed — poll for it rather than racing it.
  const answerDeadline = Date.now() + 15_000;
  while (Date.now() < answerDeadline) {
    const { body } = await httpJson<{ question: { answer?: unknown } }>(`${apiBase}${ask.links.question}`);
    if (body.question.answer !== undefined) {
      return body.question;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`case ${goldenCase.id}: job ${ask.job.id} completed but the question log never received an answer`);
}

function loadDocTexts(): Map<string, string> {
  const texts = new Map<string, string>();
  for (const flowDir of readdirSync(kbDir)) {
    const dir = path.join(kbDir, flowDir);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".md")) {
        texts.set(file, readFileSync(path.join(dir, file), "utf8"));
      }
    }
  }
  return texts;
}

function formatChecks(checks: CaseScore["checks"]): string {
  return Object.entries(checks)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${typeof value === "number" ? value.toFixed(2) : value}`)
    .join(" ");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Run via `npm run eval:golden` (scripts/test-db.mjs provides the throwaway database)."
    );
  }

  const questionSet = JSON.parse(readFileSync(questionsPath, "utf8")) as GoldenQuestionSet;
  mkdirSync(evalStateDir, { recursive: true });
  const checkoutRoot = path.join(evalStateDir, "checkouts");
  mkdirSync(checkoutRoot, { recursive: true });

  const fixturePort = await freePort();
  const apiPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  // The flow personas double as the routing vocabulary for the deterministic
  // router in the golden provider — keep them aligned with the question set.
  const sources = [
    { id: "aurora-src", name: "Aurora Docs Source", path: path.join(kbDir, "aurora") },
    { id: "handbook-src", name: "Handbook Source", path: path.join(kbDir, "handbook") }
  ];
  const destinations = [
    { id: "aurora-kb", name: "Aurora Product Docs", path: path.join(kbDir, "aurora") },
    { id: "handbook-kb", name: "Engineering Handbook", path: path.join(kbDir, "handbook") }
  ];
  const flows = [
    {
      id: "aurora",
      name: "Aurora Product Docs",
      sourceIds: ["aurora-src"],
      destinationId: "aurora-kb",
      persona:
        "You answer questions about the Aurora database product: backups, retention, deployment, regions, authentication, security, compliance, and API rate limits."
    },
    {
      id: "handbook",
      name: "Engineering Handbook",
      sourceIds: ["handbook-src"],
      destinationId: "handbook-kb",
      persona:
        "You answer questions about engineering team processes: onboarding new engineers, incident response, on-call rotations, and code review."
    }
  ];

  console.log(`[eval] golden provider on :${fixturePort}, API on :${apiPort}`);
  launch(
    "golden-provider",
    [path.join(fixturesDir, "golden-provider.mjs")],
    cleanEnv({ FIXTURE_PORT: String(fixturePort) })
  );
  await waitFor("golden provider health", BOOT_TIMEOUT_MS, async () => {
    const response = await fetch(`http://127.0.0.1:${fixturePort}/health`);
    return response.ok;
  });

  launch(
    "api",
    ["--import", "tsx", path.join(rootDir, "apps", "api", "src", "main.ts")],
    cleanEnv({
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
      AUTH_REQUIRED: "false",
      STORAGE_BACKEND: "postgres",
      KNOWLEDGE_STORE: "postgres",
      AI_PROVIDER: "openai-compatible",
      MAGPIE_CHECKOUT_ROOT: checkoutRoot,
      KNOWLEDGE_SOURCES: JSON.stringify(sources),
      KNOWLEDGE_DESTINATIONS: JSON.stringify(destinations),
      KNOWLEDGE_FLOWS: JSON.stringify(flows),
      LOG_LEVEL: "warn"
    })
  );
  await waitFor("API health", BOOT_TIMEOUT_MS, async () => {
    const response = await fetch(`${apiBase}/api/health`);
    return response.ok;
  });

  for (const flow of flows) {
    await httpJson(`${apiBase}/api/knowledge/repositories/index`, {
      method: "POST",
      body: JSON.stringify({ flowId: flow.id })
    });
  }
  const { body: stats } = await httpJson<{ sectionCount: number }>(`${apiBase}/api/knowledge/stats`);
  if (!(stats.sectionCount > 0)) {
    throw new Error(`indexing produced no sections: ${JSON.stringify(stats)}`);
  }
  console.log(`[eval] indexed golden KB (${stats.sectionCount} sections)`);

  launch(
    "watcher",
    ["--import", "tsx", path.join(rootDir, "apps", "watcher", "src", "main.ts")],
    cleanEnv({
      API_BASE_URL: apiBase,
      AUTH_REQUIRED: "false",
      AI_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${fixturePort}/v1`,
      OPENAI_COMPATIBLE_API_KEY: "golden",
      OPENAI_COMPATIBLE_MODEL: "golden-fixture",
      MAGPIE_CHECKOUT_ROOT: checkoutRoot,
      WATCHER_POLL_INTERVAL_MS: "250",
      LOG_LEVEL: "warn"
    })
  );
  await waitFor("watcher registration", BOOT_TIMEOUT_MS, async () => {
    const { body } = await httpJson<{ workers: unknown[] }>(`${apiBase}/api/workers`);
    return Array.isArray(body.workers) && body.workers.length > 0;
  });
  console.log("[eval] watcher connected — running cases");

  const docTexts = loadDocTexts();
  const caseScores: CaseScore[] = [];
  for (const goldenCase of questionSet.cases) {
    const outcome = await askCase(apiBase, goldenCase);
    const score = scoreCase(goldenCase, outcome, docTexts) as CaseScore;
    caseScores.push(score);
    console.log(`${score.passed ? "PASS" : "FAIL"} ${score.id}: ${formatChecks(score.checks)}`);
    if (!score.passed) {
      const answer = (outcome as { answer?: Record<string, unknown> }).answer ?? {};
      console.log(
        `  outcome: ${JSON.stringify({
          confidence: answer.confidence,
          citations: (answer.citations as Array<{ path?: string }> | undefined)?.map((c) => c.path),
          gaps: (answer.gaps as unknown[] | undefined)?.length ?? 0,
          outOfScope: answer.outOfScope !== undefined,
          flowSelectionRequired: answer.flowSelectionRequired !== undefined,
          trace: answer.trace,
          answer: typeof answer.answer === "string" ? answer.answer.slice(0, 200) : answer.answer
        })}`
      );
    }
  }

  const result: EvalResult = {
    questionSetVersion: questionSet.version,
    dimensions: aggregate(caseScores) as Record<string, number>,
    cases: Object.fromEntries(caseScores.map((score) => [score.id, score.passed]))
  };

  console.log("\n=== Golden eval dimensions ===");
  for (const [dimension, score] of Object.entries(result.dimensions)) {
    console.log(`${dimension.padEnd(24)} ${score.toFixed(4)}`);
  }

  appendFileSync(historyPath, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);

  if (updateBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nBaseline written to ${path.relative(rootDir, baselinePath)}.`);
    return;
  }

  let baseline: EvalResult;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as EvalResult;
  } catch {
    throw new Error(
      `No readable baseline at ${path.relative(rootDir, baselinePath)}. Run \`npm run eval:golden -- --update-baseline\` and commit the result.`
    );
  }
  if (baseline.questionSetVersion !== result.questionSetVersion) {
    throw new Error(
      `Question set version ${result.questionSetVersion} does not match baseline version ${baseline.questionSetVersion} — re-pin with --update-baseline.`
    );
  }

  const { regressions, improvements } = compareToBaseline(result, baseline);
  for (const improvement of improvements) {
    console.log(
      `IMPROVED ${improvement.kind} ${improvement.name}: ${String(improvement.baseline)} -> ${String(improvement.current)} (consider --update-baseline)`
    );
  }
  if (regressions.length > 0) {
    console.error("\n=== REGRESSIONS vs committed baseline ===");
    for (const regression of regressions) {
      console.error(
        `${regression.kind} ${regression.name}: baseline ${String(regression.baseline)} -> ${String(regression.current)}`
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("\nNo regressions against the committed baseline.");
}

main()
  .catch((error) => {
    console.error("[eval] golden eval failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    stopChildren();
  });
