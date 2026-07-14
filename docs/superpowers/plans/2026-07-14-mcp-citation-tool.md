# `kb_citation` MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MCP clients fetch the full content of cited knowledge-base sections so end users can see the evidence behind `kb_ask` answers.

**Architecture:** A new `GET /api/knowledge/sections/:id` endpoint resolves a section by id from the in-memory knowledge index; a new `kb_citation` MCP tool (both transports, shared client logic) fans out one GET per cited `sectionId` and aggregates results, mapping per-id 404s to a `missing` list instead of failing the call.

**Tech Stack:** TypeScript (ESM/NodeNext), Hono (API), `node:test`, MCP stdio + Streamable HTTP transports.

**Spec:** `docs/superpowers/specs/2026-07-14-mcp-citation-tool-design.md`

## Global Constraints

- Relative imports need explicit `.js` extensions (ESM/NodeNext).
- Never cast through `unknown`/`any`; fix types properly.
- The endpoint is guarded by `read:knowledge` — the same scope as `/knowledge/search`.
- The MCP tool is named `kb_citation`; input `sectionIds: string[]`, 1–20 entries.
- Per-id 404 → `missing` entry; any non-404 API failure fails the tool call.
- Run `npm run build && npm run typecheck && npm run lint && npm test` before each commit (workspace-scoped tests are fine mid-task; full sweep in the final task).

---

### Task 1: `getSection` on the knowledge index

**Files:**
- Modify: `apps/api/src/stores/knowledge-index.ts` (class `InMemoryKnowledgeIndex`)
- Test: `apps/api/src/stores/knowledge-index.test.ts`

**Interfaces:**
- Produces: `getSection(id: string): DocumentSection | undefined` on `InMemoryKnowledgeIndex` (Task 2 consumes it via `ctx.stores.knowledgeIndex`).

- [ ] **Step 1: Write the failing test** (append to `knowledge-index.test.ts`, matching its existing construction style)

```ts
test("getSection returns an indexed section by id and undefined for unknown ids", async () => {
  const index = new InMemoryKnowledgeIndex();
  await index.indexMarkdownDocuments({
    documents: [{ path: "guide.md", content: "# Guide\n\nBody text.\n\n## Setup\n\nInstall steps." }]
  });

  const [ranked] = await index.search("install", 1);
  assert.ok(ranked, "expected the indexed section to be searchable");

  const section = index.getSection(ranked.section.id);
  assert.deepEqual(section, ranked.section);
  assert.equal(index.getSection("nope"), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @magpie/api` (or `node --test` scoped via the workspace — never root-cwd `node --test`).
Expected: FAIL with `getSection is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `InMemoryKnowledgeIndex` (near the other simple readers):

```ts
  // Resolves one section by id — the lookup behind GET /knowledge/sections/:id,
  // which lets MCP clients expand a citation's excerpt into the full evidence.
  getSection(id: string): DocumentSection | undefined {
    return this.sections.get(id);
  }
```

- [ ] **Step 4: Run test to verify it passes** — `npm test -w @magpie/api`, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/stores/knowledge-index.ts apps/api/src/stores/knowledge-index.test.ts
git commit -m "feat(api): getSection lookup on the knowledge index"
```

### Task 2: `GET /api/knowledge/sections/:id`

**Files:**
- Modify: `apps/api/src/features/knowledge/service.ts`, `apps/api/src/features/knowledge/routes.ts`
- Test: `apps/api/src/features/knowledge/routes.test.ts`

**Interfaces:**
- Consumes: `InMemoryKnowledgeIndex.getSection` (Task 1).
- Produces: `GET /api/knowledge/sections/:id` → 200 `{ section: DocumentSection }` | 404 `section_not_found`. Task 3's client calls it.

- [ ] **Step 1: Write the failing tests** (append to `routes.test.ts`)

```ts
test("GET /api/knowledge/sections/:id returns the full section", async () => {
  const ctx = makeTestContext();
  await ctx.stores.knowledgeIndex.indexMarkdownDocuments({
    documents: [{ path: "guide.md", content: "# Guide\n\n## Setup\n\nInstall steps." }]
  });
  const [ranked] = await ctx.stores.knowledgeIndex.search("install", 1);
  assert.ok(ranked, "expected an indexed section to cite");
  const app = buildApp(ctx);

  const res = await app.request(`/api/knowledge/sections/${encodeURIComponent(ranked.section.id)}`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { section: ranked.section });
});

test("GET /api/knowledge/sections/:id returns 404 section_not_found for an unknown id", async () => {
  const ctx = makeTestContext();
  const app = buildApp(ctx);

  const res = await app.request("/api/knowledge/sections/does-not-exist");

  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "section_not_found");
});
```

(Adjust the 404 body assertion to the `HttpError` serialization the other route tests assert — check an existing 400/404 assertion in the API test suite and match it.)

- [ ] **Step 2: Run tests to verify they fail** — `npm test -w @magpie/api`, expected FAIL (404 on the happy path — route missing).

- [ ] **Step 3: Implement.** In `service.ts` (import `type { DocumentSection } from "@magpie/core"`):

```ts
// Resolves one indexed section in full — the lookup MCP's kb_citation uses to
// expand a citation's excerpt into the complete evidence passage.
export function getSection(ctx: AppContext, id: string): DocumentSection | undefined {
  return ctx.stores.knowledgeIndex.getSection(id);
}
```

In `routes.ts` (after the `/search` route):

```ts
  app.get("/sections/:id", requireScopes("read:knowledge"), (c) => {
    const section = knowledgeService.getSection(ctx, c.req.param("id"));
    if (!section) {
      throw new HttpError(404, "section_not_found");
    }

    return c.json({ section });
  });
```

- [ ] **Step 4: Run tests to verify they pass** — `npm test -w @magpie/api`, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/features/knowledge/service.ts apps/api/src/features/knowledge/routes.ts apps/api/src/features/knowledge/routes.test.ts
git commit -m "feat(api): GET /knowledge/sections/:id resolves a cited section in full"
```

### Task 3: `getCitationSections` in the shared MCP client

**Files:**
- Modify: `apps/mcp/src/kb-client.ts`
- Test: `apps/mcp/src/kb-client.test.ts`

**Interfaces:**
- Consumes: `GET /api/knowledge/sections/:id` (Task 2).
- Produces: `getCitationSections(args: Record<string, unknown> | undefined, options?: KbClientOptions): Promise<{ sections: unknown[]; missing: string[] }>` — Tasks 4 and 5 dispatch to it.

- [ ] **Step 1: Write the failing tests** (append to `kb-client.test.ts`; `jsonResponse` already exists there; add `getCitationSections` to the dynamic import at the top)

```ts
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
  globalThis.fetch = async () => jsonResponse({ error: "boom" }, 500);

  try {
    await assert.rejects(() => getCitationSections({ sectionIds: ["sec-1"] }), /failed with 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test -w @magpie/mcp`, expected FAIL (`getCitationSections` not exported).

- [ ] **Step 3: Implement** in `kb-client.ts`:

1. Give API failures a typed status so 404 is distinguishable without message-parsing. Replace the plain `Error` in `readApiResponse` with:

```ts
// API call failure carrying the HTTP status so callers can branch on it (e.g.
// kb_citation treats a per-section 404 as "missing", not a tool failure).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}
```

and in `readApiResponse`: `throw new ApiError(response.status, \`API ${path} failed with ${response.status}: ${text}\`);` (message unchanged, so existing tests/messages hold).

2. Add the citation section fetcher:

```ts
// ── citation sections ─────────────────────────────────────────────────────────

const MAX_CITATION_SECTION_IDS = 20;

// Validates kb_citation's sectionIds argument: a 1–20 entry array of non-empty
// strings, deduplicated preserving first-seen order (an answer can cite the same
// section twice; fetching it twice buys nothing).
function sectionIdsArgument(args: Record<string, unknown> | undefined): string[] {
  const value = args?.sectionIds;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("sectionIds must be a non-empty array of section id strings");
  }
  if (value.length > MAX_CITATION_SECTION_IDS) {
    throw new Error(`sectionIds accepts at most ${MAX_CITATION_SECTION_IDS} ids per call`);
  }

  const ids = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("sectionIds entries must be non-empty strings");
    }
    return entry.trim();
  });

  return [...new Set(ids)];
}

// Fetches the full content of cited sections (GET /knowledge/sections/:id per
// id, in parallel). A per-id 404 means the section was re-indexed away since
// the answer cited it — it lands in `missing` rather than failing the call, so
// the evidence that still resolves is returned. Any other API failure rejects.
export async function getCitationSections(
  args: Record<string, unknown> | undefined,
  options?: KbClientOptions
): Promise<{ sections: unknown[]; missing: string[] }> {
  const sectionIds = sectionIdsArgument(args);

  const resolved = await Promise.all(
    sectionIds.map(async (id) => {
      try {
        const response = asObject(await getJson(`/knowledge/sections/${encodeURIComponent(id)}`, options));
        return { id, section: response.section };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return { id, section: undefined };
        }
        throw error;
      }
    })
  );

  return {
    sections: resolved.filter((entry) => entry.section !== undefined).map((entry) => entry.section),
    missing: resolved.filter((entry) => entry.section === undefined).map((entry) => entry.id)
  };
}
```

- [ ] **Step 4: Run tests to verify they pass** — `npm test -w @magpie/mcp`, expected PASS (including the pre-existing kb-client suite).

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/kb-client.ts apps/mcp/src/kb-client.test.ts
git commit -m "feat(mcp): getCitationSections client fetch with per-id 404 -> missing"
```

### Task 4: Register `kb_citation` on the stdio transport

**Files:**
- Modify: `apps/mcp/src/main.ts`

**Interfaces:**
- Consumes: `getCitationSections` (Task 3).
- Produces: `kb_citation` in stdio `tools/list` + `tools/call`.

The stdio transport has no tool-dispatch test harness (only `resolveStdioAuthToken` is unit-tested); coverage comes from Task 3's client tests and Task 5's HTTP transport tests. This task is thin plumbing.

- [ ] **Step 1: Add the tool description** to the `tools` array (after `kb_seed`):

```ts
  {
    name: "kb_citation",
    description:
      "Fetch the full content of cited knowledge-base sections so the evidence behind an answer can be shown. " +
      "Pass the sectionId values from kb_ask citations (or kb_search results). Returns the currently indexed " +
      "version of each section plus a `missing` list for ids that no longer exist (the knowledge base changed " +
      "since the answer — re-ask or use kb_search).",
    inputSchema: {
      type: "object",
      properties: {
        sectionIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "The sectionId values to resolve, from kb_ask citations or kb_search results."
        }
      },
      required: ["sectionIds"],
      additionalProperties: false
    } satisfies JsonSchema
  }
```

(If the local `JsonSchema` interface's `properties` typing rejects the array schema, it already types values as `unknown` — it will accept it.)

- [ ] **Step 2: Dispatch in `callTool`** (after the `kb_seed` branch), and add `getCitationSections` to the import from `./kb-client.js`:

```ts
  if (params.name === "kb_citation") {
    const result = await getCitationSections(params.arguments, { token: stdioAuthToken });
    return textResult(result);
  }
```

- [ ] **Step 3: Validate** — `npm run build -w @magpie/mcp && npm test -w @magpie/mcp`, expected PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/main.ts
git commit -m "feat(mcp): kb_citation tool on the stdio transport"
```

### Task 5: Register `kb_citation` on the HTTP transport with scope enforcement

**Files:**
- Modify: `apps/mcp/src/http.ts`
- Test: `apps/mcp/src/http.test.ts`

**Interfaces:**
- Consumes: `getCitationSections` (Task 3).
- Produces: `kb_citation` on the HTTP transport, gated by `read:knowledge`.

- [ ] **Step 1: Write the failing test** (append near the other per-tool scope tests):

```ts
test("tools/call kb_citation requires read:knowledge scope", async () => {
  const auth = await makeTestAuth();
  const app = createHttpMcpApp(testOptions({ auth: { required: true, issuer: authIssuer, audience: authAudience, jwks: auth.jwks } }));
  const res = await request(app)
    .post("/mcp")
    .set("authorization", await auth.token(["ask:knowledge"]))
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_citation", arguments: { sectionIds: ["sec-1"] } } });
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -w @magpie/mcp`. Expected: FAIL (unknown tool bypasses the scope map, so the request is not 403).

- [ ] **Step 3: Implement** in `http.ts`:

1. `TOOL_SCOPES`: add `"kb_citation": "read:knowledge"`.
2. Import `getCitationSections` from `./kb-client.js`.
3. Register the tool (after `kb_seed`):

```ts
  server.registerTool(
    "kb_citation",
    {
      description:
        "Fetch the full content of cited knowledge-base sections so the evidence behind an answer can be " +
        "shown. Pass the sectionId values from kb_ask citations (or kb_search results). Returns the currently " +
        "indexed version of each section plus a `missing` list for ids that no longer exist (the knowledge " +
        "base changed since the answer — re-ask or use kb_search).",
      inputSchema: z.object({
        sectionIds: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("The sectionId values to resolve, from kb_ask citations or kb_search results.")
      })
    },
    async (args) => {
      const result = await getCitationSections(args, kbOptions);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
```

- [ ] **Step 4: Run tests to verify they pass** — `npm test -w @magpie/mcp`, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/http.ts apps/mcp/src/http.test.ts
git commit -m "feat(mcp): kb_citation tool on the HTTP transport gated by read:knowledge"
```

### Task 6: Documentation, full validation, PR

**Files:**
- Modify: `docs/mcp.md`, `docs/api.md`, `.claude/skills/magpie-orientation/SKILL.md`, `apps/web/src/components/McpPanel.tsx`

**Steps:**

- [ ] **Step 1: `docs/mcp.md`** — add a `### kb_citation` section after `kb_seed`:

```markdown
### `kb_citation`

Fetches the full content of cited sections so end users can see the evidence behind an answer.

Input: `{ "sectionIds": string[] }` — 1–20 `sectionId` values from `kb_ask` citations (or `kb_search` results).

Returns `{ "sections": [ DocumentSection, ... ], "missing": string[] }`. Each section is the **currently indexed** version (the KB may have changed since the answer was produced). Ids that no longer resolve land in `missing` instead of failing the call — the knowledge base changed; re-ask or use `kb_search`.
```

Also add `| kb_citation | read:knowledge |` to the per-tool scope table.

- [ ] **Step 2: `docs/api.md`** — add after the `/knowledge/search` entry:

```markdown
### `GET /api/knowledge/sections/:id`

Resolves one indexed section in full — the lookup behind MCP's `kb_citation`, which expands a citation's excerpt into the complete evidence passage.

- `404 section_not_found` — the id is not in the index (e.g. the section was re-indexed away).
- `200` — `{ "section": DocumentSection }`.
```

- [ ] **Step 3: `.claude/skills/magpie-orientation/SKILL.md`** — line ~240: `**six tools**: ...` → `**seven tools**: \`kb_ask\`, \`kb_search\`, \`kb_feedback\`, \`kb_flows\`, \`kb_outline\`, \`kb_seed\`, \`kb_citation\`.` Line ~313: `six kb_* tools` → `seven kb_* tools`.

- [ ] **Step 4: `apps/web/src/components/McpPanel.tsx`** — the tool list is stale (missing `kb_flows`, `kb_outline`, `kb_seed`). Bring it up to the full seven:

```ts
const MCP_TOOLS = [
  { name: "kb_search", blurb: "Search indexed Markdown sections by keyword." },
  { name: "kb_ask", blurb: "Ask a question and get a cited answer from the knowledge base." },
  { name: "kb_citation", blurb: "Fetch the full content of cited sections — the evidence behind an answer." },
  { name: "kb_feedback", blurb: "Flag an answer as helpful, unhelpful, or a knowledge gap." },
  { name: "kb_flows", blurb: "List the knowledge flows a question can be routed to." },
  { name: "kb_outline", blurb: "Propose a seed plan for a flow by exploring its sources." },
  { name: "kb_seed", blurb: "Approve a seed plan and draft its documents into proposals." }
];
```

(Match the actual const name and shape in the file; keep the existing ordering convention if one is apparent.)

- [ ] **Step 5: Full validation sweep**

```bash
npm run build && npm run typecheck && npm run lint && npm run deadcode && npm test
```

Expected: all green. (`test:db` needs `DOCKER_HOST` locally; run it only if Postgres-backed code changed — it did not here.)

- [ ] **Step 6: Commit docs, push, open PR to `main`**

```bash
git add docs/mcp.md docs/api.md .claude/skills/magpie-orientation/SKILL.md apps/web/src/components/McpPanel.tsx
git commit -m "docs: kb_citation tool + GET /knowledge/sections/:id"
git push -u origin claude/mcp-citation-requests-59c475
gh pr create --base main --title "feat(mcp): kb_citation tool exposes full citation evidence" --body "..."
```
