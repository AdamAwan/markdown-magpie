interface EvalCase {
  name: string;
  question: string;
  mustContain: string[];
  minCitations: number;
}

interface AskResponse {
  questionId: string;
  job: { id: string };
  links?: {
    question?: string;
    wait?: string;
  };
}

interface JobWaitResponse {
  job: { id: string; state: string };
}

interface QuestionResponse {
  question: {
    answer?: {
      answer: string;
      citations: unknown[];
    };
  };
}

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "").replace(/\/api$/, "");
const timeoutMs = Number.parseInt(process.env.EVAL_TIMEOUT_MS ?? "30000", 10);
const pollIntervalMs = 500;
const cases: EvalCase[] = parseCases(process.env.EVAL_CASES_JSON) ?? [
  {
    name: "documentation coverage",
    question: "What does this documentation cover?",
    mustContain: [],
    minCitations: 1
  }
];

function parseCases(raw: string | undefined): EvalCase[] | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("EVAL_CASES_JSON must be an array of eval cases");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`EVAL_CASES_JSON[${index}] must be an object`);
    }
    const candidate = entry as Partial<EvalCase>;
    if (typeof candidate.name !== "string" || typeof candidate.question !== "string") {
      throw new Error(`EVAL_CASES_JSON[${index}] requires name and question strings`);
    }
    return {
      name: candidate.name,
      question: candidate.question,
      mustContain: Array.isArray(candidate.mustContain) ? candidate.mustContain.map(String) : [],
      minCitations: typeof candidate.minCitations === "number" ? candidate.minCitations : 1
    };
  });
}
async function main(): Promise<void> {
  let failed = 0;

  for (const evalCase of cases) {
    const answer = await ask(evalCase.question);
    const answerText = answer.answer.toLowerCase();
    const missing = evalCase.mustContain.filter((term) => !answerText.includes(term.toLowerCase()));
    const hasEnoughCitations = answer.citations.length >= evalCase.minCitations;
    const passed = missing.length === 0 && hasEnoughCitations;

    if (!passed) {
      failed += 1;
    }

    console.log(`${passed ? "PASS" : "FAIL"} ${evalCase.name}`);
    console.log(`  question: ${evalCase.question}`);
    console.log(`  citations: ${answer.citations.length}`);
    if (missing.length > 0) {
      console.log(`  missing: ${missing.join(", ")}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function ask(question: string): Promise<{ answer: string; citations: unknown[] }> {
  // POST /ask returns 202 with a job; the watcher routes + answers it. Block on
  // GET /jobs/:id/wait (200 once terminal, 202 when still running — re-issue),
  // then read the stored answer from GET /questions/:id.
  const response = await postJson<AskResponse>("/ask", { question });
  const waitPath = response.links?.wait;
  const questionPath = response.links?.question;
  if (!waitPath || !questionPath) {
    throw new Error(`Queued answer for ${response.questionId} did not include wait/question links`);
  }

  const deadline = Date.now() + timeoutMs;
  let terminalState: string | undefined;
  while (Date.now() < deadline) {
    const { status, body } = await getWithStatus<JobWaitResponse>(waitPath);
    if (status === 200) {
      terminalState = body.job.state;
      break;
    }
    // 202 => not terminal yet; re-issue the long-poll after a short pause.
    await delay(pollIntervalMs);
  }

  if (!terminalState) {
    throw new Error(`Timed out waiting for job ${response.job.id} (question ${response.questionId}). Is a watcher running?`);
  }
  if (terminalState !== "completed") {
    throw new Error(`Job ${response.job.id} for question ${response.questionId} ended in state '${terminalState}'.`);
  }

  const result = await getJson<QuestionResponse>(questionPath);
  if (!result.question.answer) {
    throw new Error(`Job ${response.job.id} completed but question ${response.questionId} has no stored answer.`);
  }
  return result.question.answer;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path));
  return readResponse<T>(response, path);
}

async function getWithStatus<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl(path));
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }
  return { status: response.status, body: JSON.parse(text) as T };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readResponse<T>(response, path);
}

async function readResponse<T>(response: Response, path: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }

  return JSON.parse(text) as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function apiUrl(path: string): string {
  return path.startsWith("/api/") || path === "/api" ? `${apiBaseUrl}${path}` : `${apiBaseUrl}/api${path}`;
}

void main();
