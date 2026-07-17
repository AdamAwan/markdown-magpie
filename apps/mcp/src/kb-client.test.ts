import { test } from "node:test";
import assert from "node:assert/strict";

// The client reads ANSWER_POLL_INTERVAL_MS / ANSWER_TIMEOUT_MS into top-level
// consts at module-evaluation time, so the wait/poll suite must pin tiny values
// *before* it imports kb-client. ES `import` is hoisted, so we set them here (the
// first executed statement) and pull the module in via a lazy dynamic import that
// only resolves once these are in place. The getJson suite below uses the same
// already-loaded instance, which is fine — it never sleeps.
process.env.ANSWER_POLL_INTERVAL_MS = "1";
process.env.ANSWER_TIMEOUT_MS = "50";
process.env.OUTLINE_POLL_INTERVAL_MS = "1";
process.env.OUTLINE_TIMEOUT_MS = "50";

const {
  getJson,
  askQuestion,
  generateOutline,
  approveSeedPlan,
  getCitationSections,
  createQuestionnaire,
  getQuestionnaire,
  approveQuestionnaire
} = await import("./kb-client.js");

// Locks the contract Task 4 added: when a token is supplied, getJson attaches a
// single lowercase `authorization: Bearer <token>` header and nothing else.
test("getJson sends the configured bearer token", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Headers[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.fetch = fetchStub;

  try {
    const body = await getJson("/health", { token: "stdio-token" });

    assert.deepEqual(body, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get("authorization"), "Bearer stdio-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Confirms the disabled-path stays byte-identical: no token means no auth header.
test("getJson omits the authorization header when no token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Headers[] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  globalThis.fetch = fetchStub;

  try {
    await getJson("/health");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].has("authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── askQuestion wait/poll state machine ───────────────────────────────────────
//
// askQuestion is a create→wait→poll loop over the durable answer_question job:
//   POST /ask        → 202 { questionId, job, links: { wait, job } }
//   GET  links.wait  → long-poll; terminal job (200) or current projection (202)
//   GET  links.job   → detail poll, repeated until terminal
// We stub globalThis.fetch with a scripted handler keyed on URL so every branch
// is exercised hermetically — no network, and the only sleeps are the 1ms poll
// interval pinned via ANSWER_POLL_INTERVAL_MS above (timeout pinned to 50ms).

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

// Builds a fetch stub that records every requested URL and dispatches to a
// per-URL handler. Detail-poll handlers receive the (1-based) call count for
// that URL so a test can return non-terminal-then-terminal across polls.
interface StubHandlers {
  ask: () => Response;
  wait?: () => Response;
  job?: (callIndex: number) => Response;
}

function stubFetch(handlers: StubHandlers): { urls: string[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const jobCalls = new Map<string, number>();

  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);

    if (url.endsWith("/api/ask")) {
      return handlers.ask();
    }
    if (url.includes("/wait")) {
      if (!handlers.wait) {
        throw new Error(`unexpected wait request: ${url}`);
      }
      return handlers.wait();
    }
    // Detail poll: GET /api/jobs/:id
    if (!handlers.job) {
      throw new Error(`unexpected detail-poll request: ${url}`);
    }
    const next = (jobCalls.get(url) ?? 0) + 1;
    jobCalls.set(url, next);
    return handlers.job(next);
  };

  globalThis.fetch = fetchStub;
  return { urls, restore: () => (globalThis.fetch = originalFetch) };
}

const askBody = {
  questionId: "q-123",
  job: { id: "job-1", state: "created" },
  links: { wait: "/api/jobs/job-1/wait", job: "/api/jobs/job-1" }
};

const completedOutput = {
  result: {
    answer: "Magpies collect shiny markdown.",
    confidence: "high",
    citations: [{ title: "doc-a" }],
    gaps: ["nothing on corvids"]
  },
  executor: "watcher"
};

// 1. Happy path: the wait link returns a completed job; askQuestion returns the
// fields from output.result (NOT output itself) plus the questionId.
test("askQuestion returns the answer from a completed wait response", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () => jsonResponse({ job: { id: "job-1", state: "completed", output: completedOutput } })
  });

  try {
    const result = await askQuestion("where do magpies nest?");

    assert.deepEqual(result, {
      answer: "Magpies collect shiny markdown.",
      confidence: "high",
      citations: [{ title: "doc-a" }],
      gaps: ["nothing on corvids"],
      questionId: "q-123"
    });
    // ask + single wait, no detail poll needed.
    assert.equal(stub.urls.length, 2);
    assert.ok(stub.urls[1].endsWith("/api/jobs/job-1/wait"));
  } finally {
    stub.restore();
  }
});

// Multi-turn (#239): a conversationId passed in is sent on the /ask body and the
// conversationId returned by the API is surfaced back to the caller so a follow-up
// can thread onto the same exchange.
test("askQuestion sends and returns conversationId for multi-turn follow-ups", async () => {
  const originalFetch = globalThis.fetch;
  let askBodyText = "";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/ask")) {
      askBodyText = typeof init?.body === "string" ? init.body : "";
      return jsonResponse(
        { questionId: "q-9", conversationId: "conv-42", job: { id: "job-1", state: "created" }, links: askBody.links },
        202
      );
    }
    return jsonResponse({ job: { id: "job-1", state: "completed", output: completedOutput } });
  }) as typeof fetch;

  try {
    const result = await askQuestion("what about the EU?", undefined, undefined, "conv-42");
    assert.equal(JSON.parse(askBodyText).conversationId, "conv-42", "the conversationId is sent on the ask body");
    assert.equal(result.conversationId, "conv-42", "the conversationId is returned for threading follow-ups");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2. 202 wait then poll: the wait link returns a non-terminal projection, so the
// client falls back to detail polling until the job completes.
test("askQuestion polls the detail link when the wait response is non-terminal", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () => jsonResponse({ job: { id: "job-1", state: "active" } }, 202),
    job: (call) =>
      call < 2
        ? jsonResponse({ job: { id: "job-1", state: "active" } }, 202)
        : jsonResponse({ job: { id: "job-1", state: "completed", output: completedOutput } })
  });

  try {
    const result = await askQuestion("where do magpies nest?");

    assert.equal(result.answer, "Magpies collect shiny markdown.");
    assert.equal(result.questionId, "q-123");
    // ask + wait + at least two detail polls (active, then completed).
    const detailPolls = stub.urls.filter((u) => u.endsWith("/api/jobs/job-1"));
    assert.ok(detailPolls.length >= 2, `expected >=2 detail polls, got ${detailPolls.length}`);
  } finally {
    stub.restore();
  }
});

// 3a. failed terminal state: throws naming the job id + state, with no payload.
test("askQuestion throws when the job fails without leaking payload", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () =>
      jsonResponse({
        job: { id: "job-1", state: "failed", output: { secret: "do not surface" } }
      })
  });

  try {
    await assert.rejects(askQuestion("q"), (error: Error) => {
      assert.match(error.message, /job-1/);
      assert.match(error.message, /failed/);
      assert.doesNotMatch(error.message, /secret|do not surface/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// 3b. cancelled terminal state: same contract as failed.
test("askQuestion throws when the job is cancelled without leaking payload", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () =>
      jsonResponse({
        job: { id: "job-1", state: "cancelled", output: { secret: "do not surface" } }
      })
  });

  try {
    await assert.rejects(askQuestion("q"), (error: Error) => {
      assert.match(error.message, /job-1/);
      assert.match(error.message, /cancelled/);
      assert.doesNotMatch(error.message, /secret|do not surface/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// 4. Deadline/timeout: the job never reaches a terminal state within the pinned
// 50ms timeout, so askQuestion throws a timeout error naming the id + last state.
test("askQuestion times out when the job never reaches a terminal state", async () => {
  const stub = stubFetch({
    ask: () => jsonResponse(askBody, 202),
    wait: () => jsonResponse({ job: { id: "job-1", state: "active" } }, 202),
    job: () => jsonResponse({ job: { id: "job-1", state: "retry" } }, 202)
  });

  try {
    await assert.rejects(askQuestion("q"), (error: Error) => {
      assert.match(error.message, /Timed out/);
      assert.match(error.message, /job-1/);
      assert.match(error.message, /retry/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// 5. Missing links: an ask response without usable wait/job links is rejected up
// front with the dedicated links error (the wait handler is never reached).
test("askQuestion throws when the ask response omits job links", async () => {
  const stub = stubFetch({
    // `links` present but with no wait/job entries → the dedicated links error.
    ask: () => jsonResponse({ questionId: "q-123", job: { id: "job-1", state: "created" }, links: {} }, 202)
  });

  try {
    await assert.rejects(askQuestion("q"), /did not include job wait\/detail links/);
    // Only the ask call happened — no wait/poll attempted.
    assert.equal(stub.urls.length, 1);
  } finally {
    stub.restore();
  }
});

// ── generateOutline wait/poll state machine ───────────────────────────────────
//
// generateOutline is a create→wait→poll→fetch-plan loop over the durable
// outline_flow_seed job. The create response carries only { ok, jobId } (no
// links), so the client builds the wait/detail paths itself:
//   POST /flows/:id/outline     → { ok, jobId, reused }
//   GET  /jobs/:id/wait          → long-poll; terminal job (200) or projection (202)
//   GET  /jobs/:id               → detail poll, repeated until terminal
//   GET  /flows/:id/seed-plans   → the persisted plan whose outlineJobId matches
// Same 1ms poll interval / 50ms timeout pinned above.

// Builds a fetch stub for the outline flow, dispatching on the outline POST, the
// wait link, the detail-poll link, and the seed-plans list. Detail handlers
// receive the (1-based) call count so a test can return non-terminal-then-
// terminal across polls.
interface OutlineStubHandlers {
  outline: () => Response;
  wait?: () => Response;
  job?: (callIndex: number) => Response;
  plans?: () => Response;
}

function stubOutlineFetch(handlers: OutlineStubHandlers): { urls: string[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const jobCalls = new Map<string, number>();

  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);

    if (url.endsWith("/outline")) {
      return handlers.outline();
    }
    if (url.endsWith("/seed-plans")) {
      if (!handlers.plans) {
        throw new Error(`unexpected seed-plans request: ${url}`);
      }
      return handlers.plans();
    }
    if (url.includes("/wait")) {
      if (!handlers.wait) {
        throw new Error(`unexpected wait request: ${url}`);
      }
      return handlers.wait();
    }
    if (!handlers.job) {
      throw new Error(`unexpected detail-poll request: ${url}`);
    }
    const next = (jobCalls.get(url) ?? 0) + 1;
    jobCalls.set(url, next);
    return handlers.job(next);
  };

  globalThis.fetch = fetchStub;
  return { urls, restore: () => (globalThis.fetch = originalFetch) };
}

const persistedPlan = {
  id: "plan-1",
  flowId: "magpie-support",
  status: "proposed",
  origin: "manual",
  charter: "Cover the prompt library end to end",
  charterProposed: true,
  personaProposed: false,
  items: [
    { id: "i1", status: "proposed", title: "Prompt library overview", coverage: ["what each prompt does"] },
    {
      id: "i2",
      status: "proposed",
      title: "Flow personas",
      targetPath: "personas.md",
      coverage: ["the support persona"]
    }
  ],
  rationale: "Two non-overlapping docs cover the library and its personas.",
  outlineJobId: "job-9"
};

const outlineArgs = { flow: "magpie-support", notes: "focus on the prompt library" };

// 1. Happy path: outline POST returns a jobId, the wait link returns a completed
// job, and generateOutline fetches the persisted plan whose outlineJobId matches
// and returns its review shape (planId + charter flags + items + rationale).
test("generateOutline returns the persisted plan after the job completes", async () => {
  const stub = stubOutlineFetch({
    outline: () => jsonResponse({ ok: true, jobId: "job-9", reused: false }),
    wait: () => jsonResponse({ job: { id: "job-9", state: "completed" } }),
    plans: () => jsonResponse({ plans: [{ ...persistedPlan, outlineJobId: "other" }, persistedPlan] })
  });

  try {
    const result = await generateOutline(outlineArgs);

    assert.equal(result.planId, "plan-1");
    assert.equal(result.charter, "Cover the prompt library end to end");
    assert.equal(result.charterProposed, true);
    assert.equal(result.personaProposed, false);
    assert.equal(result.items.length, 2);
    assert.equal(result.rationale, persistedPlan.rationale);
    // outline POST + single wait + plan fetch, no detail poll needed.
    assert.equal(stub.urls.length, 3);
    assert.ok(stub.urls[0].endsWith("/api/flows/magpie-support/outline"));
    assert.ok(stub.urls[1].endsWith("/api/jobs/job-9/wait"));
    assert.ok(stub.urls[2].endsWith("/api/flows/magpie-support/seed-plans"));
  } finally {
    stub.restore();
  }
});

// 2. 202 wait then poll: the wait link returns a non-terminal projection, so the
// client falls back to detail polling until the job completes.
test("generateOutline polls the detail link when the wait response is non-terminal", async () => {
  const stub = stubOutlineFetch({
    outline: () => jsonResponse({ ok: true, jobId: "job-9", reused: false }),
    wait: () => jsonResponse({ job: { id: "job-9", state: "active" } }, 202),
    job: (call) =>
      call < 2
        ? jsonResponse({ job: { id: "job-9", state: "active" } }, 202)
        : jsonResponse({ job: { id: "job-9", state: "completed" } }),
    plans: () => jsonResponse({ plans: [persistedPlan] })
  });

  try {
    const result = await generateOutline(outlineArgs);

    assert.equal(result.items.length, 2);
    assert.equal(result.planId, "plan-1");
    const detailPolls = stub.urls.filter((u) => u.endsWith("/api/jobs/job-9"));
    assert.ok(detailPolls.length >= 2, `expected >=2 detail polls, got ${detailPolls.length}`);
  } finally {
    stub.restore();
  }
});

// 2b. A completed run whose plan row is missing (e.g. deleted between the wait
// and the fetch) is an explicit error naming the job, never a silent empty plan.
test("generateOutline throws when no persisted plan matches the completed job", async () => {
  const stub = stubOutlineFetch({
    outline: () => jsonResponse({ ok: true, jobId: "job-9", reused: false }),
    wait: () => jsonResponse({ job: { id: "job-9", state: "completed" } }),
    plans: () => jsonResponse({ plans: [] })
  });

  try {
    await assert.rejects(generateOutline(outlineArgs), /job-9.*no persisted plan/);
  } finally {
    stub.restore();
  }
});

// 3. failed terminal state: throws naming the job id + state, with no payload.
test("generateOutline throws when the job fails without leaking payload", async () => {
  const stub = stubOutlineFetch({
    outline: () => jsonResponse({ ok: true, jobId: "job-9" }),
    wait: () => jsonResponse({ job: { id: "job-9", state: "failed", output: { secret: "do not surface" } } })
  });

  try {
    await assert.rejects(generateOutline(outlineArgs), (error: Error) => {
      assert.match(error.message, /job-9/);
      assert.match(error.message, /failed/);
      assert.doesNotMatch(error.message, /secret|do not surface/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// 4. Deadline/timeout: the job never reaches a terminal state within the pinned
// 50ms timeout, so generateOutline throws a timeout error naming the id + state.
test("generateOutline times out when the job never reaches a terminal state", async () => {
  const stub = stubOutlineFetch({
    outline: () => jsonResponse({ ok: true, jobId: "job-9" }),
    wait: () => jsonResponse({ job: { id: "job-9", state: "active" } }, 202),
    job: () => jsonResponse({ job: { id: "job-9", state: "retry" } }, 202)
  });

  try {
    await assert.rejects(generateOutline(outlineArgs), (error: Error) => {
      assert.match(error.message, /Timed out/);
      assert.match(error.message, /job-9/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// 5. Missing job id: an outline response without a jobId is rejected up front —
// the wait link is never built (only the outline POST happened).
test("generateOutline throws when the outline response omits a job id", async () => {
  const stub = stubOutlineFetch({
    outline: () => jsonResponse({ ok: true })
  });

  try {
    await assert.rejects(generateOutline(outlineArgs), /did not include a job id/);
    assert.equal(stub.urls.length, 1);
  } finally {
    stub.restore();
  }
});

// ── approveSeedPlan ────────────────────────────────────────────────────────────
//
// kb_seed approves a persisted plan: one POST to /seed-plans/:id/approve, jobIds
// passed through. Status rules (409 on a non-proposed plan) are server-side and
// surface through the normal HTTP error path.
test("approveSeedPlan POSTs the approve route and returns the enqueued job ids", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return jsonResponse({ plan: { id: "plan-1", status: "approved" }, jobIds: ["draft-1", "draft-2"] });
  }) as typeof fetch;

  try {
    const result = await approveSeedPlan({ plan: "plan-1" });
    assert.deepEqual(result, { planId: "plan-1", jobIds: ["draft-1", "draft-2"] });
    assert.equal(urls.length, 1);
    assert.ok(urls[0].endsWith("/api/seed-plans/plan-1/approve"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── getCitationSections ───────────────────────────────────────────────────────

test("getCitationSections aggregates found sections and turns 404s into missing", async () => {
  const originalFetch = globalThis.fetch;
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/knowledge/sections/sec-1")) {
      return jsonResponse({ section: { id: "sec-1", heading: "Setup", content: "Full text" } });
    }
    return jsonResponse({ error: "section_not_found" }, 404);
  };
  globalThis.fetch = fetchStub;

  try {
    const result = await getCitationSections({ sectionIds: ["sec-1", "sec-2"] });
    assert.deepEqual(result, {
      sections: [{ id: "sec-1", heading: "Setup", content: "Full text" }],
      missing: ["sec-2"]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getCitationSections dedupes ids and preserves input order", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    const id = decodeURIComponent(url.split("/").pop() ?? "");
    return jsonResponse({ section: { id } });
  };
  globalThis.fetch = fetchStub;

  try {
    const result = await getCitationSections({ sectionIds: ["b", "a", "b"] });
    assert.deepEqual(result.sections, [{ id: "b" }, { id: "a" }]);
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getCitationSections rejects invalid sectionIds input", async () => {
  await assert.rejects(() => getCitationSections({}), /sectionIds must be a non-empty array/);
  await assert.rejects(() => getCitationSections({ sectionIds: [] }), /sectionIds must be a non-empty array/);
  await assert.rejects(() => getCitationSections({ sectionIds: [1] }), /non-empty strings/);
  await assert.rejects(
    () => getCitationSections({ sectionIds: Array.from({ length: 21 }, (_, i) => `s${i}`) }),
    /at most 20/
  );
});

test("getCitationSections propagates non-404 API failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch;

  try {
    await assert.rejects(() => getCitationSections({ sectionIds: ["sec-1"] }), /failed with 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── questionnaires ────────────────────────────────────────────────────────────
//
// The questionnaire tools are thin, deliberately non-waiting wrappers over the
// questionnaire routes (docs/questionnaires.md): create returns the worksheet as
// the API left it — items may still be pending/answering, the caller re-reads
// with getQuestionnaire — and the view drops internal ids (questionLogId,
// reusedFromItemId) and citation fingerprints the model has no use for, while
// keeping the item id kb_questionnaire_approve targets.

// A worksheet as the API returns it, carrying every internal field the view is
// expected to strip: log/reuse ids, citation fingerprints and excerpts,
// staleAtApproval, createdAt.
const questionnaireBody = {
  questionnaire: {
    id: "qn-1",
    name: "Q3 security review",
    flowId: "magpie-support",
    status: "open",
    createdAt: "2026-07-16T00:00:00.000Z",
    items: [
      {
        id: "item-1",
        questionnaireId: "qn-1",
        position: 0,
        question: "Do you encrypt data at rest?",
        status: "answered",
        outcome: "reused",
        answer: "Yes — AES-256 across all stores.",
        confidence: "high",
        answeredAt: "2026-04-01T00:00:00.000Z",
        questionLogId: "log-1",
        reusedFromItemId: "prior-1",
        staleAtApproval: false,
        citations: [
          { sectionId: "sec-1", contentHash: "abc123", path: "security.md", heading: "Encryption", excerpt: "…" }
        ]
      },
      {
        id: "item-2",
        questionnaireId: "qn-1",
        position: 1,
        question: "Do you rotate encryption keys?",
        status: "pending",
        outcome: "changed",
        changeReason: {
          kind: "section_changed",
          sectionId: "sec-2",
          path: "security.md",
          heading: "Key rotation",
          changedAt: "2026-07-01T00:00:00.000Z"
        },
        staleAtApproval: false,
        citations: []
      }
    ]
  }
};

// The shaped view for the worksheet above: internal ids and citation
// fingerprints gone, item id/statuses/answers/confidence/changeReason kept.
const questionnaireView = {
  id: "qn-1",
  name: "Q3 security review",
  flowId: "magpie-support",
  status: "open",
  items: [
    {
      id: "item-1",
      position: 0,
      question: "Do you encrypt data at rest?",
      status: "answered",
      outcome: "reused",
      answer: "Yes — AES-256 across all stores.",
      confidence: "high",
      citations: [{ path: "security.md", heading: "Encryption" }]
    },
    {
      id: "item-2",
      position: 1,
      question: "Do you rotate encryption keys?",
      status: "pending",
      outcome: "changed",
      changeReason: {
        kind: "section_changed",
        sectionId: "sec-2",
        path: "security.md",
        heading: "Key rotation",
        changedAt: "2026-07-01T00:00:00.000Z"
      },
      citations: []
    }
  ]
};

test("createQuestionnaire POSTs name/flowId/questions and returns the shaped worksheet", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    });
    return jsonResponse(questionnaireBody, 201);
  }) as typeof fetch;

  try {
    const result = await createQuestionnaire({
      name: "Q3 security review",
      flow: "magpie-support",
      questions: ["Do you encrypt data at rest?", "Do you rotate encryption keys?"]
    });

    assert.deepEqual(result, questionnaireView);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/questionnaires"));
    assert.equal(calls[0].method, "POST");
    // The `flow` argument travels as the route's flowId field.
    assert.deepEqual(calls[0].body, {
      name: "Q3 security review",
      flowId: "magpie-support",
      questions: ["Do you encrypt data at rest?", "Do you rotate encryption keys?"]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createQuestionnaire rejects invalid arguments before any API call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no API call expected");
  }) as typeof fetch;

  try {
    await assert.rejects(() => createQuestionnaire({ flow: "f", questions: ["q"] }), /name must be a non-empty string/);
    await assert.rejects(() => createQuestionnaire({ name: "n", questions: ["q"] }), /flow must be a non-empty string/);
    await assert.rejects(() => createQuestionnaire({ name: "n", flow: "f" }), /questions must be a non-empty array/);
    await assert.rejects(
      () => createQuestionnaire({ name: "n", flow: "f", questions: [] }),
      /questions must be a non-empty array/
    );
    await assert.rejects(
      () => createQuestionnaire({ name: "n", flow: "f", questions: ["q", 2] }),
      /questions entries must be non-empty strings/
    );
    await assert.rejects(
      () => createQuestionnaire({ name: "n", flow: "f", questions: Array.from({ length: 501 }, (_, i) => `q${i}`) }),
      /at most 500/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getQuestionnaire GETs the worksheet and strips internal ids and fingerprints", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return jsonResponse(questionnaireBody);
  }) as typeof fetch;

  try {
    const result = await getQuestionnaire({ questionnaire: "qn-1" });

    assert.deepEqual(result, questionnaireView);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].endsWith("/api/questionnaires/qn-1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approveQuestionnaire without an item bulk-approves reused items", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
    return jsonResponse({ approved: 2 });
  }) as typeof fetch;

  try {
    const result = await approveQuestionnaire({ questionnaire: "qn-1" });

    assert.deepEqual(result, { approved: 2 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/questionnaires/qn-1/approve-reused"));
    assert.equal(calls[0].method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approveQuestionnaire with an item approves that single item", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  try {
    const result = await approveQuestionnaire({ questionnaire: "qn-1", item: "item-1" });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/questionnaires/qn-1/items/item-1/approve"));
    assert.equal(calls[0].method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("questionnaire calls pass API errors through with their status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ error: "not_answered" }, 409)) as typeof fetch;

  try {
    await assert.rejects(() => approveQuestionnaire({ questionnaire: "qn-1", item: "item-2" }), /failed with 409/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
