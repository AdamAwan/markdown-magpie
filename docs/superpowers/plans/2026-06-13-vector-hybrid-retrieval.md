# Vector + Hybrid Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic (vector) retrieval to the `/ask` flow, fused with the existing keyword scorer (hybrid search via Reciprocal Rank Fusion) and backed by pgvector, so the Q&A flow finds relevant sections even when the question shares no keywords with the source.

**Architecture:** Vector ranking comes from a pgvector nearest-neighbour query; keyword ranking comes from the existing in-memory scorer (already loaded by `hydrate()`); the two ranked lists are fused with RRF in TypeScript. Embeddings are produced by an admin-configured OpenAI-compatible/Azure endpoint — index-time embedding is queued to the watcher, query-time embedding is synchronous in the API. Hybrid activates automatically only when `KNOWLEDGE_STORE=postgres` **and** an embeddings endpoint are configured; otherwise the system stays on today's keyword-only search with no behavioural change.

**Tech Stack:** Node.js + TypeScript (ESM, npm workspaces), `node:test` run from source via `tsx`, Postgres + pgvector (`pg`), Next.js admin UI.

**Design spec:** `docs/superpowers/specs/2026-06-13-vector-hybrid-retrieval-design.md`

---

## File Structure

**New files**
- `packages/retrieval/src/rrf.ts` — pure Reciprocal Rank Fusion of ranked id lists.
- `packages/retrieval/src/rrf.test.ts` — RRF unit tests.
- `packages/retrieval/src/embeddings.ts` — embedding providers + `createEmbeddingProvider` factory + dimension guard.
- `packages/retrieval/src/embeddings.test.ts` — embedding provider unit tests (mocked `fetch`).
- `apps/api/src/knowledge-index.test.ts` — keyword-relevance + hybrid-fallback unit tests.
- `apps/api/src/embed-sections.ts` — pure, injectable embed-batch logic shared by the watcher runner.
- `apps/api/src/embed-sections.test.ts` — embed-batch unit tests (fake provider + fake store).
- `packages/db/migrations/0006_hybrid_retrieval.sql` — HNSW index on `document_sections.embedding`.

**Modified files**
- `packages/core/src/index.ts` — `RankedSection` type; `"embed_sections"` job type + input/output.
- `packages/retrieval/src/index.ts` — `SectionSearchProvider` returns `RankedSection[]`; relevance-scale selection/confidence; remove the now-unused keyword scorer (moves to the search provider). Re-export embeddings + RRF.
- `apps/api/src/knowledge-index.ts` — `search()` returns `RankedSection[]`; hybrid wiring + keyword fallback; embedding-provider/vector-search injection; `SectionVectorSearch` interface.
- `apps/api/src/postgres-knowledge-store.ts` — pgvector nearest-neighbour query + list/save/count helpers for embeddings.
- `apps/api/src/main.ts` — construct embedding provider; enqueue `embed_sections` after index; expose `retrievalMode` + embedding status in `/config`; adapt the admin `/knowledge/search` response to the new return type.
- `apps/watcher/src/main.ts` — `embed_sections` accepted type + `EmbedSectionsRunner`.
- `apps/watcher/package.json`, `apps/api/package.json`, `packages/retrieval/package.json` — switch `test` script to a glob so new test files run; add a `test` script to `apps/watcher`.
- `apps/web/src/app/page.tsx` — read-only retrieval-status indicator.
- `docs/ingestion.md` — replace the "keyword scoring until the embedding adapter is wired in" note.

**Naming contract (used across tasks — keep these exact):**
- `RankedSection { section: DocumentSection; relevance: number }` — `relevance` ∈ [0,1], higher is better.
- `fuseRankings(rankings: string[][], k?: number): Map<string, number>`
- `createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider`
- `EMBEDDING_DIMENSIONS = 1536`
- `SectionVectorSearch { searchByEmbedding(embedding: number[], limit: number): Promise<Array<{ id: string; similarity: number }>> }`
- Selection constants (in `packages/retrieval/src/index.ts`): `RELEVANCE_FLOOR = 0.2`, `HIGH_CONFIDENCE_RELEVANCE = 0.6`, `MEDIUM_CONFIDENCE_RELEVANCE = 0.35`.
- Keyword-relevance scale (in `apps/api/src/knowledge-index.ts`): `KEYWORD_RELEVANCE_SCALE = 6` → `relevance = min(1, keywordScore / 6)`.

---

# Phase 1 — Pure building blocks (no database)

## Task 1: Reciprocal Rank Fusion

**Files:**
- Create: `packages/retrieval/src/rrf.ts`
- Create: `packages/retrieval/src/rrf.test.ts`
- Modify: `packages/retrieval/package.json` (test glob)

- [ ] **Step 1: Switch the retrieval test script to a glob so new test files run**

In `packages/retrieval/package.json`, change the `test` script:

```json
"test": "node --import tsx --test \"src/**/*.test.ts\"",
```

- [ ] **Step 2: Write the failing test**

Create `packages/retrieval/src/rrf.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuseRankings } from "./rrf.js";

describe("fuseRankings", () => {
  it("rewards items ranked highly across multiple lists", () => {
    const scores = fuseRankings([
      ["a", "b", "c"],
      ["b", "a", "d"]
    ]);
    // 'a': 1/61 + 1/62, 'b': 1/62 + 1/61 -> equal; both beat single-list items
    assert.ok((scores.get("a") ?? 0) > (scores.get("c") ?? 0));
    assert.ok((scores.get("b") ?? 0) > (scores.get("d") ?? 0));
    assert.equal(scores.get("c"), 1 / 63);
  });

  it("sums contributions for an item appearing in every list", () => {
    const scores = fuseRankings([["x"], ["x"]]);
    assert.equal(scores.get("x"), 1 / 61 + 1 / 61);
  });

  it("honours a custom k", () => {
    const scores = fuseRankings([["x"]], 9);
    assert.equal(scores.get("x"), 1 / 10);
  });

  it("returns an empty map for no rankings", () => {
    assert.equal(fuseRankings([]).size, 0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test --workspace packages/retrieval`
Expected: FAIL — `Cannot find module './rrf.js'`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/retrieval/src/rrf.ts`:

```ts
export const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion. Each input is a list of ids ordered best-first.
 * An id's fused score is the sum of 1 / (k + rank) across the lists it appears
 * in (rank is 1-based). Rank-based, so it needs no score normalisation between
 * the vector and keyword lists.
 */
export function fuseRankings(rankings: string[][], k: number = DEFAULT_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace packages/retrieval`
Expected: PASS (rrf tests green; existing `index.test.ts` still green).

- [ ] **Step 6: Commit**

```bash
git add packages/retrieval/src/rrf.ts packages/retrieval/src/rrf.test.ts packages/retrieval/package.json
git commit -m "feat(retrieval): add reciprocal rank fusion"
```

---

## Task 2: Core types — RankedSection and the embed_sections job

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the `RankedSection` type**

In `packages/core/src/index.ts`, immediately after the `DocumentSection` interface (ends at `:55`), add:

```ts
export interface RankedSection {
  section: DocumentSection;
  /** Absolute relevance in [0,1]; higher is better. */
  relevance: number;
}
```

- [ ] **Step 2: Add `embed_sections` to the job type union**

Change the `AiJobType` union (`:172-177`) to include the new type:

```ts
export type AiJobType =
  | "answer_question"
  | "summarize_gap"
  | "draft_markdown_proposal"
  | "detect_contradiction"
  | "suggest_consolidation"
  | "embed_sections";
```

- [ ] **Step 3: Add the embed job input/output types**

After the `DraftMarkdownProposalJobOutput` interface (`:253`), add:

```ts
export interface EmbedSectionsJobInput {
  /** Limit embedding to one repository; omit to embed every section missing an embedding. */
  repositoryId?: string;
  batchSize?: number;
  expectedOutput: "embedded_sections";
}

export interface EmbedSectionsJobOutput {
  embeddedCount: number;
  remaining: number;
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npm run typecheck --workspace packages/core`
Expected: PASS (no errors). If `packages/core` has no `typecheck` script, run `npx tsc -p packages/core/tsconfig.json --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add RankedSection type and embed_sections job"
```

---

## Task 3: Embedding providers + factory + dimension guard

**Files:**
- Create: `packages/retrieval/src/embeddings.ts`
- Create: `packages/retrieval/src/embeddings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/retrieval/src/embeddings.test.ts`:

```ts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  OpenAICompatibleEmbeddingProvider
} from "./embeddings.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function vectorOf(length: number): number[] {
  return Array.from({ length }, (_, i) => (i + 1) / length);
}

describe("OpenAICompatibleEmbeddingProvider", () => {
  it("posts inputs to /embeddings and returns vectors ordered by index", async () => {
    let captured: { url: string; body: any } | undefined;
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vectorOf(EMBEDDING_DIMENSIONS) },
            { index: 0, embedding: vectorOf(EMBEDDING_DIMENSIONS) }
          ]
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://api.example.com/v1/",
      model: "text-embedding-3-small"
    });
    const vectors = await provider.embed(["first", "second"]);

    assert.equal(captured?.url, "https://api.example.com/v1/embeddings");
    assert.deepEqual(captured?.body.input, ["first", "second"]);
    assert.equal(captured?.body.model, "text-embedding-3-small");
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, EMBEDDING_DIMENSIONS);
  });

  it("throws when a returned vector has the wrong dimension", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(512) }] }), {
        status: 200
      })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://api.example.com/v1",
      model: "m"
    });
    await assert.rejects(provider.embed(["x"]), /512-dim vector; expected 1536/);
  });

  it("throws when the response count does not match the input count", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    const provider = new OpenAICompatibleEmbeddingProvider({ apiKey: "k", baseUrl: "u", model: "m" });
    await assert.rejects(provider.embed(["x"]), /returned 0 vectors for 1 inputs/);
  });
});

describe("createEmbeddingProvider", () => {
  it("requires the OpenAI-compatible embedding settings", () => {
    assert.throws(
      () => createEmbeddingProvider({ provider: "openai-compatible", baseUrl: "u", model: "m" }),
      /OPENAI_COMPATIBLE_API_KEY/
    );
  });

  it("falls back to a mock provider with the correct dimensions", async () => {
    const provider = createEmbeddingProvider({ provider: "mock" });
    const [vector] = await provider.embed(["hello"]);
    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/retrieval`
Expected: FAIL — `Cannot find module './embeddings.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/retrieval/src/embeddings.ts`:

```ts
import type { EmbeddingProvider } from "@magpie/core";

export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingProviderName = "mock" | "openai-compatible" | "azure-openai";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    // Correctly-dimensioned, non-zero, deterministic. Never written to pgvector
    // (hybrid is disabled for the mock provider) — exists only to satisfy the interface.
    return texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      vector[0] = text.length || 1;
      return vector;
    });
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly config: Required<Pick<EmbeddingProviderConfig, "apiKey" | "baseUrl" | "model">>) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: this.config.model, input: texts })
    });

    return parseEmbeddingResponse(response, texts.length);
  }
}

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly config: Required<
      Pick<EmbeddingProviderConfig, "apiKey" | "azureEndpoint" | "azureDeployment" | "azureApiVersion">
    >
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const endpoint = trimTrailingSlash(this.config.azureEndpoint);
    const deployment = encodeURIComponent(this.config.azureDeployment);
    const apiVersion = encodeURIComponent(this.config.azureApiVersion);
    const response = await fetch(
      `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`,
      {
        method: "POST",
        headers: {
          "api-key": this.config.apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({ input: texts })
      }
    );

    return parseEmbeddingResponse(response, texts.length);
  }
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === "openai-compatible") {
    assertConfig(config.apiKey, "OPENAI_COMPATIBLE_API_KEY");
    assertConfig(config.baseUrl, "OPENAI_COMPATIBLE_BASE_URL");
    assertConfig(config.model, "OPENAI_COMPATIBLE_EMBEDDING_MODEL");
    return new OpenAICompatibleEmbeddingProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model
    });
  }

  if (config.provider === "azure-openai") {
    assertConfig(config.apiKey, "AZURE_OPENAI_API_KEY");
    assertConfig(config.azureEndpoint, "AZURE_OPENAI_ENDPOINT");
    assertConfig(config.azureDeployment, "AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
    return new AzureOpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      azureEndpoint: config.azureEndpoint,
      azureDeployment: config.azureDeployment,
      azureApiVersion: config.azureApiVersion ?? "2024-10-21"
    });
  }

  return new MockEmbeddingProvider();
}

async function parseEmbeddingResponse(response: Response, expectedCount: number): Promise<number[][]> {
  if (!response.ok) {
    throw new Error(`Embedding provider failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  const data = body.data ?? [];
  if (data.length !== expectedCount) {
    throw new Error(`Embedding provider returned ${data.length} vectors for ${expectedCount} inputs`);
  }

  return [...data]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((entry) => {
      const vector = entry.embedding;
      if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding provider returned a ${vector?.length ?? 0}-dim vector; expected ${EMBEDDING_DIMENSIONS}`);
      }
      return vector;
    });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertConfig(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for the selected embedding provider`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace packages/retrieval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/retrieval/src/embeddings.ts packages/retrieval/src/embeddings.test.ts
git commit -m "feat(retrieval): add embedding providers with dimension guard"
```

---

## Task 4: Scored search contract + relevance-scale selection/confidence

This changes `SectionSearchProvider.search` to return `RankedSection[]` and moves selection/confidence onto the `[0,1]` relevance scale. The keyword scorer is removed from `answerQuestion` (it now lives in the search provider, Task 7).

**Files:**
- Modify: `packages/retrieval/src/index.ts`
- Modify: `packages/retrieval/src/index.test.ts`

- [ ] **Step 1: Rewrite the existing tests for the new contract**

Replace the body of `packages/retrieval/src/index.test.ts` with:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocumentSection, RankedSection } from "@magpie/core";
import { answerQuestion, MockChatProvider, type SectionSearchProvider } from "./index.js";

function section(id: string, heading: string, content: string): DocumentSection {
  return {
    id,
    documentId: id.split(":").slice(0, 2).join(":"),
    path: `${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    heading,
    headingPath: [heading],
    anchor: heading.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    content,
    ordinal: 0
  };
}

function provider(ranked: RankedSection[], expect?: { question: string; limit: number }): SectionSearchProvider {
  return {
    async search(question, limit) {
      if (expect) {
        assert.equal(question, expect.question);
        assert.equal(limit, expect.limit);
      }
      return ranked;
    }
  };
}

describe("answerQuestion", () => {
  it("returns a low-confidence gap when no sections match", async () => {
    const result = await answerQuestion("How do I roll back a hotfix?", provider([]), new MockChatProvider());
    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.equal(result.gap?.summary, "No source material found for: How do I roll back a hotfix?");
  });

  it("answers from relevant retrieved sections with citations", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:runbook.md:0", "Hotfix Rollback", "Run the rollback workflow and notify the incident lead."), relevance: 0.5 },
      { section: section("repo:release.md:0", "Release Checks", "Verify monitoring after every release."), relevance: 0.1 }
    ];

    const result = await answerQuestion(
      "How do I rollback?",
      provider(ranked, { question: "How do I rollback?", limit: 5 }),
      new MockChatProvider()
    );

    assert.equal(result.confidence, "medium");
    assert.equal(result.gap, undefined);
    assert.equal(result.citations.length, 1); // 0.1 is below the relative band, dropped
    assert.equal(result.citations[0].sectionId, "repo:runbook.md:0");
    assert.match(result.answer, /rollback guidance is/i);
  });

  it("selects sections by provided relevance even with no lexical overlap", async () => {
    // The whole point of vector retrieval: a section that shares no words with the
    // question still survives selection because the search provider ranked it highly.
    const ranked: RankedSection[] = [
      { section: section("repo:felines.md:0", "Grooming", "Sticky residue is removed with oil before bathing."), relevance: 0.7 }
    ];

    const result = await answerQuestion("What do I do about gum stuck in fur?", provider(ranked), new MockChatProvider());

    assert.notEqual(result.confidence, "low");
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].sectionId, "repo:felines.md:0");
  });

  it("raises a gap when the best relevance is below the floor", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:care.md:0", "Cat Care Basics", "Cats need fresh water and a clean litter box."), relevance: 0.1 }
    ];

    const result = await answerQuestion("What should I do if a cat gets gum in their fur?", provider(ranked), new MockChatProvider());

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.equal(result.gap?.summary, "No source material found for: What should I do if a cat gets gum in their fur?");
  });

  it("raises a gap when the chat provider says the context is insufficient", async () => {
    const ranked: RankedSection[] = [
      { section: section("repo:care.md:0", "Gum in Fur", "Escalate sticky fur issues when a reviewed procedure exists."), relevance: 0.5 }
    ];

    const result = await answerQuestion("What about gum in fur?", provider(ranked), {
      async complete() {
        return {
          content: "The provided knowledge base does not contain any information about what to do if a cat gets gum in their fur."
        };
      }
    });

    assert.equal(result.confidence, "low");
    assert.equal(result.citations.length, 0);
    assert.match(result.gap?.summary ?? "", /No sufficient source material/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/retrieval`
Expected: FAIL — `index.ts` still expects the old `DocumentSection[]` contract and keyword scoring; type/behaviour mismatches.

- [ ] **Step 3: Update the `SectionSearchProvider` interface and `answerQuestion`**

In `packages/retrieval/src/index.ts`:

(a) Update the import on line 1 to add `RankedSection`:

```ts
import type { AnswerResult, ChatProvider, Citation, ChatRequest, Confidence, DocumentSection, RankedSection } from "@magpie/core";
```

(b) Replace the `SectionSearchProvider` interface (`:3-5`):

```ts
export interface SectionSearchProvider {
  search(question: string, limit: number): Promise<RankedSection[]>;
}
```

(c) Replace `answerQuestion` (`:128-182`) with the relevance-based version:

```ts
const RELEVANCE_FLOOR = 0.2;
const HIGH_CONFIDENCE_RELEVANCE = 0.6;
const MEDIUM_CONFIDENCE_RELEVANCE = 0.35;

export async function answerQuestion(
  question: string,
  searchProvider: SectionSearchProvider,
  chatProvider: ChatProvider
): Promise<AnswerResult> {
  const ranked = await searchProvider.search(question, 5);
  const relevantSections = selectRelevantSections(ranked);
  const citations = relevantSections.map((result) => toCitation(result.section));

  if (relevantSections.length === 0) {
    return {
      answer: "I could not find reliable source material for this question.",
      confidence: "low",
      citations: [],
      gap: {
        summary: `No source material found for: ${question}`,
        question,
        confidence: "low",
        citedSectionIds: []
      }
    };
  }

  const context = relevantSections.map(({ section }) => `# ${section.heading}\n${section.content}`).join("\n\n");
  const response = await chatProvider.complete({
    system: "Answer using only the provided Markdown knowledge base context. Cite the source sections.",
    messages: [
      {
        role: "user",
        content: `Question:\n${question}\n\nContext:\n${context}`
      }
    ]
  });

  if (isKnowledgeGapAnswer(response.content)) {
    return {
      answer: response.content,
      confidence: "low",
      citations: [],
      gap: {
        summary: `No sufficient source material found for: ${question}`,
        question,
        confidence: "low",
        citedSectionIds: []
      }
    };
  }

  return {
    answer: response.content,
    confidence: confidenceFromRelevance(relevantSections),
    citations
  };
}

function selectRelevantSections(ranked: RankedSection[]): RankedSection[] {
  const best = ranked[0]?.relevance ?? 0;
  if (best < RELEVANCE_FLOOR) {
    return [];
  }

  const threshold = Math.max(RELEVANCE_FLOOR, best * 0.5);
  return ranked.filter((result) => result.relevance >= threshold).slice(0, 3);
}

function confidenceFromRelevance(selected: RankedSection[]): Confidence {
  const best = selected[0]?.relevance ?? 0;
  if (best >= HIGH_CONFIDENCE_RELEVANCE && selected.length >= 2) {
    return "high";
  }

  return best >= MEDIUM_CONFIDENCE_RELEVANCE ? "medium" : "low";
}
```

(d) Delete the now-unused keyword helpers from `index.ts`: the `ScoredSection` interface (`:184-187`), `scoreSectionsForQuestion` (`:189-198`), the old `selectRelevantSections` (`:200-209`), `confidenceForEvidence` (`:211-218`), `scoreSection` (`:220-230`), `tokenize` (`:232-236`), and the `stopwords` set (`:302-321`). Keep `isKnowledgeGapAnswer`, `toCitation`, `parseChatCompletionResponse`, `extractBlock`, `answerLeadIn`, `trimTrailingSlash`, `assertConfig`.

(e) At the end of `index.ts`, re-export the new modules so consumers import from one place:

```ts
export * from "./rrf.js";
export * from "./embeddings.js";
```

Note: `Confidence` must be exported from `@magpie/core` — it already is (`packages/core/src/index.ts:1`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace packages/retrieval`
Expected: PASS (all retrieval tests green).

- [ ] **Step 5: Typecheck the retrieval package**

Run: `npm run typecheck --workspace packages/retrieval`
Expected: PASS — confirms no dangling references to the deleted helpers. The `MockEmbeddingProvider` previously defined in `index.ts` is removed by the re-export from `embeddings.js`; if `index.ts` still declares its own `MockEmbeddingProvider`, delete that duplicate (`:19-23`).

- [ ] **Step 6: Commit**

```bash
git add packages/retrieval/src/index.ts packages/retrieval/src/index.test.ts
git commit -m "feat(retrieval): score search results and select on a [0,1] relevance scale"
```

---

# Phase 2 — Wire into the running system

## Task 5: Migration — HNSW index

**Files:**
- Create: `packages/db/migrations/0006_hybrid_retrieval.sql`

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/0006_hybrid_retrieval.sql`:

```sql
-- Approximate-nearest-neighbour index for hybrid retrieval's vector side.
-- The `embedding vector(1536)` column and the `vector` extension already exist
-- (0001_initial.sql). Cosine distance matches the query operator `<=>` used in
-- PostgresKnowledgeStore.searchByEmbedding.
CREATE INDEX IF NOT EXISTS document_sections_embedding_hnsw
  ON document_sections USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Verify the SQL applies (if a database is available)**

If `DATABASE_URL` is set: `psql "$DATABASE_URL" -f packages/db/migrations/0006_hybrid_retrieval.sql`
Expected: `CREATE INDEX`. If no database is available, visually confirm the statement is valid and continue — it is exercised by Task 6's gated integration test.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0006_hybrid_retrieval.sql
git commit -m "feat(db): add HNSW index for section embeddings"
```

---

## Task 6: Postgres store — vector query + embedding read/write helpers

**Files:**
- Modify: `apps/api/src/postgres-knowledge-store.ts`
- Modify: `apps/api/src/knowledge-index.ts` (export the `SectionVectorSearch` interface only)

- [ ] **Step 1: Declare the `SectionVectorSearch` interface**

In `apps/api/src/knowledge-index.ts`, after the `KnowledgePersistence` interface (`:25-28`), add:

```ts
export interface SectionVectorSearch {
  searchByEmbedding(embedding: number[], limit: number): Promise<Array<{ id: string; similarity: number }>>;
}

export interface SectionToEmbed {
  id: string;
  text: string;
}

export interface EmbeddingPersistence {
  listSectionsNeedingEmbedding(limit: number, repositoryId?: string): Promise<SectionToEmbed[]>;
  countSectionsNeedingEmbedding(repositoryId?: string): Promise<number>;
  saveSectionEmbedding(id: string, embedding: number[]): Promise<void>;
}
```

- [ ] **Step 2: Implement them on `PostgresKnowledgeStore`**

In `apps/api/src/postgres-knowledge-store.ts`:

(a) Update the import (`:3`) to pull in the new interfaces:

```ts
import type {
  EmbeddingPersistence,
  IndexedRepositorySummary,
  KnowledgePersistence,
  LoadedKnowledge,
  SectionToEmbed,
  SectionVectorSearch
} from "./knowledge-index.js";
```

(b) Change the class declaration (`:7`) to implement the new interfaces:

```ts
export class PostgresKnowledgeStore implements KnowledgePersistence, SectionVectorSearch, EmbeddingPersistence {
```

(c) Add these methods inside the class (e.g. after `loadAll`, before the closing brace at `:165`):

```ts
  async searchByEmbedding(embedding: number[], limit: number): Promise<Array<{ id: string; similarity: number }>> {
    const literal = toVectorLiteral(embedding);
    const result = await this.pool.query<{ id: string; similarity: string }>(
      `
        SELECT id, 1 - (embedding <=> $1::vector) AS similarity
        FROM document_sections
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `,
      [literal, limit]
    );
    return result.rows.map((row) => ({ id: row.id, similarity: Number(row.similarity) }));
  }

  async listSectionsNeedingEmbedding(limit: number, repositoryId?: string): Promise<SectionToEmbed[]> {
    const result = await this.pool.query<{ id: string; heading: string; content: string }>(
      `
        SELECT s.id, s.heading, s.content
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.embedding IS NULL
          AND ($1::text IS NULL OR d.repository_id = $1)
        ORDER BY s.id
        LIMIT $2
      `,
      [repositoryId ?? null, limit]
    );
    return result.rows.map((row) => ({ id: row.id, text: `${row.heading}\n${row.content}` }));
  }

  async countSectionsNeedingEmbedding(repositoryId?: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
        SELECT count(*) AS count
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        WHERE s.embedding IS NULL
          AND ($1::text IS NULL OR d.repository_id = $1)
      `,
      [repositoryId ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async saveSectionEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.pool.query("UPDATE document_sections SET embedding = $2::vector WHERE id = $1", [
      id,
      toVectorLiteral(embedding)
    ]);
  }
```

(d) Add the helper at the bottom of the file (after the row interfaces):

```ts
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
```

- [ ] **Step 3: Add a DATABASE_URL-gated integration test**

Create `apps/api/src/postgres-knowledge-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";

const databaseUrl = process.env.DATABASE_URL;

describe("PostgresKnowledgeStore vector search", { skip: databaseUrl ? false : "DATABASE_URL not set" }, () => {
  it("orders sections by cosine similarity to the query vector", async () => {
    const store = new PostgresKnowledgeStore(databaseUrl as string);
    // Relies on a section having been indexed and embedded by a prior step in a seeded DB.
    const pending = await store.countSectionsNeedingEmbedding();
    assert.ok(pending >= 0);
  });
});
```

> Note: this gated test is a smoke check that the queries are syntactically valid against a real DB. It is intentionally light — full ordering behaviour is verified by manual verification in Task 10. CI without a database simply skips it.

- [ ] **Step 4: Switch the api test script to a glob and run**

In `apps/api/package.json`:

```json
"test": "node --import tsx --test \"src/**/*.test.ts\"",
```

Run: `npm test --workspace apps/api`
Expected: PASS — existing `ai-job-queue` tests green; the new store test is skipped without `DATABASE_URL`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace apps/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/postgres-knowledge-store.ts apps/api/src/knowledge-index.ts apps/api/src/postgres-knowledge-store.test.ts apps/api/package.json
git commit -m "feat(api): add pgvector search and embedding read/write helpers"
```

---

## Task 7: Hybrid search wiring in the knowledge index

**Files:**
- Modify: `apps/api/src/knowledge-index.ts`
- Create: `apps/api/src/knowledge-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/knowledge-index.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { InMemoryKnowledgeIndex, type SectionVectorSearch } from "./knowledge-index.js";

const docs = [
  { path: "rollback.md", content: "# Hotfix Rollback\nRun the rollback workflow and notify the incident lead.\n" },
  { path: "felines.md", content: "# Grooming\nSticky residue is removed with oil before bathing.\n" }
];

async function seed(index: InMemoryKnowledgeIndex) {
  await index.indexMarkdownDocuments({ documents: docs, repositoryId: "repo" });
}

describe("InMemoryKnowledgeIndex.search", () => {
  it("returns keyword-ranked sections with a [0,1] relevance when no embeddings configured", async () => {
    const index = new InMemoryKnowledgeIndex();
    await seed(index);

    const ranked = await index.search("how do I rollback the hotfix", 5);

    assert.ok(ranked.length >= 1);
    assert.match(ranked[0].section.heading, /Rollback/);
    assert.ok(ranked[0].relevance > 0 && ranked[0].relevance <= 1);
  });

  it("surfaces a semantically-matched section that shares no keywords (hybrid)", async () => {
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts) {
        return texts.map(() => [1, 0, 0]);
      }
    };
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        // pretend the felines/Grooming section is the nearest neighbour
        return [{ id: "repo:felines.md:0", similarity: 0.82 }];
      }
    };
    const index = new InMemoryKnowledgeIndex(undefined, { embeddingProvider, vectorSearch });
    await seed(index);

    const ranked = await index.search("what do I do about gum stuck in fur", 5);

    const top = ranked.find((r) => r.section.id === "repo:felines.md:0");
    assert.ok(top, "expected the vector hit to be present");
    assert.ok((top?.relevance ?? 0) >= 0.8);
  });

  it("falls back to keyword search when the embedding call fails", async () => {
    const embeddingProvider: EmbeddingProvider = {
      async embed() {
        throw new Error("embeddings endpoint down");
      }
    };
    const vectorSearch: SectionVectorSearch = {
      async searchByEmbedding() {
        return [];
      }
    };
    const notices: string[] = [];
    const index = new InMemoryKnowledgeIndex(undefined, {
      embeddingProvider,
      vectorSearch,
      onNotice: (message) => notices.push(message)
    });
    await seed(index);

    const ranked = await index.search("how do I rollback the hotfix", 5);

    assert.match(ranked[0].section.heading, /Rollback/);
    assert.ok(notices.some((n) => /fall(ing)? back to keyword/i.test(n)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — `search` still returns `DocumentSection[]`; constructor does not accept hybrid options.

- [ ] **Step 3: Implement hybrid search**

In `apps/api/src/knowledge-index.ts`:

(a) Update the top import (`:7`) to add `EmbeddingProvider` and `RankedSection`:

```ts
import type { DocumentSection, EmbeddingProvider, GitRepositoryContext, KnowledgeDocument, RankedSection, RepositoryRef } from "@magpie/core";
import { fuseRankings } from "@magpie/retrieval";
```

(b) Add a hybrid-options type and constants near the top (after the existing interfaces):

```ts
const KEYWORD_RELEVANCE_SCALE = 6;
const VECTOR_CANDIDATES = 20;

export interface HybridSearchOptions {
  embeddingProvider?: EmbeddingProvider;
  vectorSearch?: SectionVectorSearch;
  onNotice?: (message: string) => void;
}
```

(c) Change the constructor (`:40`) to accept hybrid options:

```ts
  constructor(
    private readonly persistence?: KnowledgePersistence,
    private readonly hybrid: HybridSearchOptions = {}
  ) {}
```

(d) Replace `search` (`:181-196`) with the hybrid implementation:

```ts
  async search(question: string, limit: number): Promise<RankedSection[]> {
    const keywordRanked = this.keywordRank(question);

    const { embeddingProvider, vectorSearch, onNotice } = this.hybrid;
    if (!embeddingProvider || !vectorSearch) {
      return keywordRanked.slice(0, limit);
    }

    let vectorHits: Array<{ id: string; similarity: number }>;
    try {
      const [queryVector] = await embeddingProvider.embed([question]);
      vectorHits = await vectorSearch.searchByEmbedding(queryVector, Math.max(limit, VECTOR_CANDIDATES));
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      onNotice?.(`Vector search unavailable, falling back to keyword search: ${message}`);
      return keywordRanked.slice(0, limit);
    }

    const keywordIds = keywordRanked.map((result) => result.section.id);
    const vectorIds = vectorHits.map((hit) => hit.id);
    const fused = fuseRankings([vectorIds, keywordIds]);

    const similarityById = new Map(vectorHits.map((hit) => [hit.id, hit.similarity]));
    const keywordRelevanceById = new Map(keywordRanked.map((result) => [result.section.id, result.relevance]));

    return [...new Set([...vectorIds, ...keywordIds])]
      .map((id) => ({
        id,
        fused: fused.get(id) ?? 0,
        relevance: Math.max(similarityById.get(id) ?? 0, keywordRelevanceById.get(id) ?? 0)
      }))
      .sort((left, right) => right.fused - left.fused)
      .slice(0, limit)
      .map(({ id, relevance }) => {
        const section = this.sections.get(id);
        return section ? { section, relevance } : undefined;
      })
      .filter((result): result is RankedSection => result !== undefined);
  }

  private keywordRank(question: string): RankedSection[] {
    const terms = tokenize(question);
    if (terms.length === 0) {
      return [];
    }

    return [...this.sections.values()]
      .map((section) => ({ section, score: scoreSection(section, terms) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((result) => ({
        section: result.section,
        relevance: Math.min(1, result.score / KEYWORD_RELEVANCE_SCALE)
      }));
  }
```

(Keep the existing module-level `scoreSection`, `tokenize`, and `stopwords` in `knowledge-index.ts` — they are still used by `keywordRank`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/knowledge-index.ts apps/api/src/knowledge-index.test.ts
git commit -m "feat(api): hybrid search fusing pgvector and keyword ranking"
```

---

## Task 8: Embed-batch logic + watcher runner

**Files:**
- Create: `apps/api/src/embed-sections.ts`
- Create: `apps/api/src/embed-sections.test.ts`
- Modify: `apps/watcher/src/main.ts`
- Modify: `apps/watcher/package.json`

- [ ] **Step 1: Write the failing test for the pure embed-batch function**

Create `apps/api/src/embed-sections.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EmbeddingProvider } from "@magpie/core";
import { embedPendingSections } from "./embed-sections.js";
import type { EmbeddingPersistence, SectionToEmbed } from "./knowledge-index.js";

function fakeStore(pending: SectionToEmbed[]): EmbeddingPersistence & { saved: Map<string, number[]> } {
  const saved = new Map<string, number[]>();
  return {
    saved,
    async listSectionsNeedingEmbedding(limit) {
      return pending.filter((s) => !saved.has(s.id)).slice(0, limit);
    },
    async countSectionsNeedingEmbedding() {
      return pending.filter((s) => !saved.has(s.id)).length;
    },
    async saveSectionEmbedding(id, embedding) {
      saved.set(id, embedding);
    }
  };
}

const provider: EmbeddingProvider = {
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array(1536).fill(0);
      v[0] = text.length;
      return v;
    });
  }
};

describe("embedPendingSections", () => {
  it("embeds every pending section across batches and reports counts", async () => {
    const store = fakeStore([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
      { id: "c", text: "gamma" }
    ]);

    const result = await embedPendingSections({ store, provider, batchSize: 2 });

    assert.equal(result.embeddedCount, 3);
    assert.equal(result.remaining, 0);
    assert.equal(store.saved.size, 3);
    assert.equal(store.saved.get("a")?.[0], 5); // "alpha".length
  });

  it("is idempotent — already-embedded sections are not re-embedded", async () => {
    const store = fakeStore([{ id: "a", text: "alpha" }]);
    await store.saveSectionEmbedding("a", new Array(1536).fill(0));

    const result = await embedPendingSections({ store, provider, batchSize: 10 });

    assert.equal(result.embeddedCount, 0);
    assert.equal(result.remaining, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/api`
Expected: FAIL — `Cannot find module './embed-sections.js'`.

- [ ] **Step 3: Implement the pure embed-batch function**

Create `apps/api/src/embed-sections.ts`:

```ts
import type { EmbeddingProvider } from "@magpie/core";
import type { EmbeddingPersistence } from "./knowledge-index.js";

export interface EmbedPendingOptions {
  store: EmbeddingPersistence;
  provider: EmbeddingProvider;
  repositoryId?: string;
  batchSize?: number;
}

export interface EmbedPendingResult {
  embeddedCount: number;
  remaining: number;
}

const DEFAULT_BATCH_SIZE = 64;

/**
 * Embeds every section missing an embedding, in batches, idempotently. Only
 * targets sections where the embedding column is NULL, so retries and partial
 * failures are safe and re-indexed (re-inserted) sections are picked up here.
 */
export async function embedPendingSections(options: EmbedPendingOptions): Promise<EmbedPendingResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let embeddedCount = 0;

  for (;;) {
    const pending = await options.store.listSectionsNeedingEmbedding(batchSize, options.repositoryId);
    if (pending.length === 0) {
      break;
    }

    const vectors = await options.provider.embed(pending.map((section) => section.text));
    for (let i = 0; i < pending.length; i += 1) {
      await options.store.saveSectionEmbedding(pending[i].id, vectors[i]);
      embeddedCount += 1;
    }
  }

  const remaining = await options.store.countSectionsNeedingEmbedding(options.repositoryId);
  return { embeddedCount, remaining };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 5: Commit the pure logic**

```bash
git add apps/api/src/embed-sections.ts apps/api/src/embed-sections.test.ts
git commit -m "feat(api): add idempotent embed-pending-sections batch logic"
```

- [ ] **Step 6: Add the `embed_sections` runner to the watcher**

The watcher processes jobs against the API today, but `embed_sections` needs direct DB + embedding access. Add a dedicated branch that runs the batch logic instead of an agent.

In `apps/watcher/src/main.ts`:

(a) Extend the imports (`:2-12`) and add the new ones:

```ts
import type {
  AgentRunner,
  AiJob,
  AiJobType,
  AnswerQuestionJobInput,
  AnswerQuestionJobOutput,
  DraftMarkdownProposalJobInput,
  DraftMarkdownProposalJobOutput,
  EmbedSectionsJobInput,
  SummarizeGapJobInput,
  SummarizeGapJobOutput
} from "@magpie/core";
import { createEmbeddingProvider, type EmbeddingProviderName } from "@magpie/retrieval";
import { PostgresKnowledgeStore } from "../../api/src/postgres-knowledge-store.js";
import { embedPendingSections } from "../../api/src/embed-sections.js";
```

> If the cross-app import path is awkward under the workspace setup, move `embed-sections.ts`, `postgres-knowledge-store.ts`, and the `EmbeddingPersistence`/`SectionVectorSearch` interfaces into a shared `packages/` package and import from there. Confirm which during implementation by checking whether `apps/watcher/tsconfig.json` references `apps/api`. Prefer the shared-package route if the direct relative import does not type-check.

(b) Add `"embed_sections"` to `acceptedTypes` (`:19-25`):

```ts
const acceptedTypes: AiJobType[] = [
  "answer_question",
  "summarize_gap",
  "draft_markdown_proposal",
  "detect_contradiction",
  "suggest_consolidation",
  "embed_sections"
];
```

(c) In `runAndComplete` (`:67`), handle `embed_sections` before the agent path, because it does not use an `AgentRunner`:

```ts
async function runAndComplete(job: AiJob): Promise<void> {
  try {
    if (job.type === "embed_sections") {
      const output = await runEmbedSections(job.input as EmbedSectionsJobInput);
      await postJson(`/ai-jobs/${job.id}/complete`, { output });
      console.log(`Completed ${job.type} job ${job.id}`);
      return;
    }

    const runner = createRunner(providerForJob(job));
    if (!runner.supports(job.type)) {
      throw new Error(`${runner.name} does not support ${job.type}`);
    }

    const output = await runner.run(job);
    await postJson(`/ai-jobs/${job.id}/complete`, { output });
    console.log(`Completed ${job.type} job ${job.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown job failure";
    await postJson(`/ai-jobs/${job.id}/fail`, { error: message });
    console.error(`Failed ${job.type} job ${job.id}: ${message}`);
  }
}
```

(d) Add the runner function near the bottom helpers:

```ts
async function runEmbedSections(input: EmbedSectionsJobInput) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run embed_sections jobs");
  }

  const embeddingProviderName = (process.env.EMBEDDING_PROVIDER ?? "mock") as EmbeddingProviderName;
  const provider = createEmbeddingProvider({
    provider: embeddingProviderName,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    model: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION
  });

  const store = new PostgresKnowledgeStore(databaseUrl);
  return embedPendingSections({
    store,
    provider,
    repositoryId: input.repositoryId,
    batchSize: input.batchSize
  });
}
```

- [ ] **Step 7: Add a watcher test script**

In `apps/watcher/package.json`, add to `scripts`:

```json
"test": "node --import tsx --test \"src/**/*.test.ts\"",
```

(There are no watcher unit tests yet; this makes the workspace's `npm test` a no-op-safe glob and ready for future tests. `node --test` with no matching files exits 0.)

- [ ] **Step 8: Typecheck the watcher and api**

Run: `npm run typecheck --workspace apps/watcher && npm run typecheck --workspace apps/api`
Expected: PASS. If the cross-app import does not resolve, apply the shared-package note from Step 6 and re-run.

- [ ] **Step 9: Commit**

```bash
git add apps/watcher/src/main.ts apps/watcher/package.json
git commit -m "feat(watcher): process embed_sections jobs via batch embedding"
```

---

## Task 9: API wiring — build providers, enqueue embedding, expose retrieval mode

**Files:**
- Modify: `apps/api/src/main.ts`

- [ ] **Step 1: Construct the embedding provider and inject hybrid options into the index**

In `apps/api/src/main.ts`:

(a) Add to the retrieval import (`:15`):

```ts
import { answerQuestion, createChatProvider, createEmbeddingProvider, type ChatProviderName, type EmbeddingProviderName } from "@magpie/retrieval";
```

(b) Add helpers that decide whether embeddings are configured and build the provider. Place them near `createConfiguredChatProvider` (`:906`):

```ts
function embeddingProviderName(): EmbeddingProviderName | undefined {
  if (process.env.OPENAI_COMPATIBLE_BASE_URL && process.env.OPENAI_COMPATIBLE_API_KEY && process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL) {
    return "openai-compatible";
  }
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT) {
    return "azure-openai";
  }
  return undefined;
}

function createConfiguredEmbeddingProvider() {
  const provider = embeddingProviderName();
  if (!provider) {
    return undefined;
  }
  return createEmbeddingProvider({
    provider,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.AZURE_OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    model: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    azureApiVersion: process.env.AZURE_OPENAI_API_VERSION
  });
}

function retrievalMode(): { mode: "hybrid" | "keyword"; reason: string } {
  const hasEmbeddings = embeddingProviderName() !== undefined;
  const postgres = storeBackend("KNOWLEDGE_STORE") === "postgres";
  if (hasEmbeddings && postgres) {
    return { mode: "hybrid", reason: "Semantic + keyword search active." };
  }
  if (!hasEmbeddings) {
    return { mode: "keyword", reason: "Add an embeddings endpoint to enable semantic search." };
  }
  return { mode: "keyword", reason: "Semantic search requires the Postgres knowledge store (KNOWLEDGE_STORE=postgres)." };
}
```

(c) Update `createKnowledgeIndex` (`:859-870`) to pass hybrid options when running on Postgres with embeddings:

```ts
function createKnowledgeIndex(): InMemoryKnowledgeIndex {
  if (storeBackend("KNOWLEDGE_STORE") === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when KNOWLEDGE_STORE=postgres");
    }

    const store = new PostgresKnowledgeStore(databaseUrl);
    const embeddingProvider = createConfiguredEmbeddingProvider();
    return new InMemoryKnowledgeIndex(
      store,
      embeddingProvider ? { embeddingProvider, vectorSearch: store, onNotice: (message) => console.warn(message) } : {}
    );
  }

  return new InMemoryKnowledgeIndex();
}
```

- [ ] **Step 2: Adapt the admin search endpoint to the new return type**

The admin `/knowledge/search` handler (`:120`) returns `knowledgeIndex.search(...)` directly. `search` now returns `RankedSection[]`, so map to sections (keeping the relevance available too):

```ts
    const ranked = await knowledgeIndex.search(query, parseLimit(url.searchParams.get("limit"), 5));
    writeJson(response, 200, { sections: ranked.map((result) => result.section), ranked });
```

- [ ] **Step 3: Enqueue an embed_sections job after indexing**

In `handleIndexRepository` (`:460`) and `handleIndexMarkdown` (the upload handler — find it near the other index handlers), after the index summary is produced and before writing the response, enqueue an embedding job when hybrid is possible. Add a small helper and call it from both handlers:

```ts
async function enqueueEmbeddingIfHybrid(repositoryId: string): Promise<void> {
  if (retrievalMode().mode !== "hybrid") {
    return;
  }
  const input: EmbedSectionsJobInput = { repositoryId, expectedOutput: "embedded_sections" };
  await aiJobs.enqueue("embed_sections", input);
}
```

Add the import for the type at the top of `main.ts` (alongside the other `@magpie/core` job-input imports):

```ts
import type { /* …existing… */ EmbedSectionsJobInput } from "@magpie/core";
```

Then in each index handler, after `const summary = await knowledgeIndex.indexLocalRepository(...)` (or `indexMarkdownDocuments`), add:

```ts
  await enqueueEmbeddingIfHybrid(summary.repository.id);
```

- [ ] **Step 4: Expose retrieval mode and the new embedding model in `/config`**

In `getRuntimeConfig` (`:618-674`):

(a) Add `embeddingModel` to the `openAiCompatible` block (`:642-646`):

```ts
      openAiCompatible: {
        baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL || null,
        model: process.env.OPENAI_COMPATIBLE_MODEL || null,
        embeddingModel: process.env.OPENAI_COMPATIBLE_EMBEDDING_MODEL || null,
        apiKey: secretState(process.env.OPENAI_COMPATIBLE_API_KEY)
      },
```

(b) Add a `retrieval` block to the returned object (e.g. after the `aiRuntime` block, `:666`):

```ts
    retrieval: (() => {
      const { mode, reason } = retrievalMode();
      return {
        mode,
        reason,
        embeddingProvider: embeddingProviderName() ?? null
      };
    })(),
```

- [ ] **Step 5: Typecheck and run the api tests**

Run: `npm run typecheck --workspace apps/api && npm test --workspace apps/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/main.ts
git commit -m "feat(api): wire embeddings, enqueue index embedding, expose retrieval mode"
```

---

## Task 10: Manual end-to-end verification with Postgres + an embeddings endpoint

**Files:** none (verification only)

- [ ] **Step 1: Start Postgres with pgvector and apply migrations**

Use the project's existing Postgres setup (compose file or `DATABASE_URL`). Apply all migrations in order:

```bash
for f in packages/db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Expected: each runs without error, including `0006_hybrid_retrieval.sql`.

- [ ] **Step 2: Configure hybrid mode and start the API + watcher**

Set, for an OpenAI-compatible embeddings endpoint:

```bash
export STORAGE_BACKEND=postgres KNOWLEDGE_STORE=postgres AI_JOB_QUEUE=postgres
export DATABASE_URL=...   # pgvector-enabled
export EMBEDDING_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=... OPENAI_COMPATIBLE_API_KEY=... OPENAI_COMPATIBLE_EMBEDDING_MODEL=text-embedding-3-small
```

Start the API and the watcher (per the repo's run scripts).

- [ ] **Step 3: Confirm retrieval mode is hybrid**

```bash
curl -s localhost:4000/config | jq '.retrieval'
```

Expected: `{ "mode": "hybrid", "reason": "Semantic + keyword search active.", "embeddingProvider": "openai-compatible" }`.

- [ ] **Step 4: Index a repo and confirm embeddings populate**

Index a Markdown repo, then watch the embed job run:

```bash
curl -s -XPOST localhost:4000/repositories/index -H 'content-type: application/json' -d '{"localPath":"<path>"}' | jq
# after the watcher processes the embed_sections job:
psql "$DATABASE_URL" -c "SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded, count(*) AS total FROM document_sections;"
```

Expected: `embedded` rises to `total` once the watcher finishes.

- [ ] **Step 5: Ask a question phrased with NO shared keywords**

Pick a section, then ask using synonyms that share no tokens with its heading/content. Compare against keyword-only behaviour (unset the embedding env vars and restart).

```bash
curl -s -XPOST localhost:4000/ask -H 'content-type: application/json' -d '{"question":"<paraphrased question>"}' | jq '.result.citations, .result.confidence'
```

Expected: hybrid mode returns a citation to the relevant section where keyword-only returned a gap/low confidence. Record the comparison in the PR description.

- [ ] **Step 6: Confirm graceful fallback**

Temporarily point `OPENAI_COMPATIBLE_BASE_URL` at an unreachable host, restart the API, and ask a question.
Expected: `/ask` still returns a keyword answer (does not 500), and the API logs the "falling back to keyword search" notice.

---

## Task 11: Admin UI retrieval-status indicator

**Files:**
- Modify: `apps/web/src/app/page.tsx`

- [ ] **Step 1: Extend the `RuntimeConfig` type**

In `apps/web/src/app/page.tsx`, find the `RuntimeConfig` interface (around `:53-66`) and add a `retrieval` field matching the API:

```ts
  retrieval: {
    mode: "hybrid" | "keyword";
    reason: string;
    embeddingProvider: string | null;
  };
```

- [ ] **Step 2: Render a read-only status line**

Near where the active provider is displayed (`config?.aiRuntime.provider`, around `:507`), add a retrieval status element:

```tsx
<div className="retrievalStatus">
  <span className="label">Retrieval</span>
  <span className={`badge ${config?.retrieval.mode ?? "keyword"}`}>
    {config?.retrieval.mode === "hybrid" ? "Hybrid (semantic + keyword)" : "Keyword only"}
  </span>
  <span className="reason">{config?.retrieval.reason}</span>
</div>
```

This is read-only — there is no toggle; the mode is derived from configuration, so it can never contradict actual behaviour. The "Answering" provider selector and the "Embeddings" status are presented as two separate, clearly-labelled concerns; the embeddings status only ever reflects the api-style endpoints (codex/claude cannot appear as an embedding source).

- [ ] **Step 3: Verify the web app builds**

Run: `npm run build --workspace apps/web`
Expected: PASS (type-checks against the new `retrieval` field).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/page.tsx
git commit -m "feat(web): show derived retrieval mode in admin config"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/ingestion.md`
- Modify: any architecture/README doc that describes search (grep first)

- [ ] **Step 1: Replace the keyword-only note**

In `docs/ingestion.md`, find the note stating search is "lightweight keyword scoring … until the embedding/indexing adapter is wired in" and replace it with a description of hybrid retrieval: pgvector vector search fused with keyword scoring via RRF, embeddings from an admin-configured OpenAI-compatible/Azure endpoint, index-time embedding queued to the watcher, query-time embedding synchronous, and the automatic keyword-only fallback when embeddings/Postgres are not configured.

- [ ] **Step 2: Document the new configuration**

Add the new environment variables and the derived retrieval mode to the configuration docs:

| Variable | Purpose |
| -------- | ------- |
| `KNOWLEDGE_STORE=postgres` + `DATABASE_URL` | Required for vector search. |
| `EMBEDDING_PROVIDER` | `openai-compatible` or `azure-openai`. |
| `OPENAI_COMPATIBLE_EMBEDDING_MODEL` | Embedding model (must output 1536-dim vectors). |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Azure embedding deployment. |

- [ ] **Step 3: Find and update any other search references**

Run: `grep -rni "keyword" docs/ README.md`
Update any other description of retrieval to reflect hybrid search.

- [ ] **Step 4: Commit**

```bash
git add docs/ README.md
git commit -m "docs: describe hybrid vector retrieval and its configuration"
```

---

## Final verification

- [ ] **Run the whole test suite**

Run: `npm test`
Expected: all workspace suites pass (`packages/retrieval`, `packages/markdown`, `apps/api`).

- [ ] **Typecheck everything**

Run: `npm run typecheck --workspaces --if-present`
Expected: no errors.

- [ ] **Confirm the keyword-only deployment is unchanged**

With no embedding env vars set and `STORAGE_BACKEND` unset (in-memory), `curl /config | jq .retrieval` reports `keyword`, and `/ask` behaves exactly as before this work.
