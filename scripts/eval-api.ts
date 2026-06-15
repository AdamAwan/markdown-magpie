interface EvalCase {
  name: string;
  question: string;
  mustContain: string[];
  minCitations: number;
}

interface AskResponse {
  questionId: string;
  result?: {
    answer: string;
    citations: unknown[];
  };
  links?: {
    question?: string;
  };
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
const cases: EvalCase[] = [
  {
    name: "scratching behavior",
    question: "Why do cats scratch?",
    mustContain: ["territory", "claws"],
    minCitations: 1
  },
  {
    name: "adoption preparation",
    question: "What supplies do I need before adopting a cat?",
    mustContain: ["veterinarian", "introduction"],
    minCitations: 1
  },
  {
    name: "urgent warning signs",
    question: "What are urgent cat warning signs?",
    mustContain: ["urgent", "breathing"],
    minCitations: 1
  }
];

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
  const response = await postJson<AskResponse>("/ask", { question });
  if (response.result) {
    return response.result;
  }

  if (!response.links?.question) {
    throw new Error(`Queued answer for ${response.questionId} did not include a question link`);
  }

  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(pollIntervalMs);
    const result = await getJson<QuestionResponse>(response.links.question);
    if (result.question.answer) {
      return result.question.answer;
    }
  }

  throw new Error(
    `Timed out waiting for queued answer ${response.questionId}. Start the watcher or run the API with AI_EXECUTION_MODE=mock/direct for evals.`
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path));
  return readResponse<T>(response, path);
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
