# Local Embeddings Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator enable semantic retrieval with no third-party account by turning on one compose profile, and document honestly what it costs in quality and what it does not deliver.

**Architecture:** Add an opt-in `embeddings` compose profile running Hugging Face Text Embeddings Inference, which serves an OpenAI-compatible `/v1/embeddings` — so the existing `openai-compatible` provider talks to it with no adapter. Two things in the application block that today: the response parser hard-rejects non-1536-dimension vectors, and provider selection demands an API key an unauthenticated local server does not have. Fix both, then document per-model threshold overrides rather than changing tuned production defaults.

**Tech Stack:** TypeScript (ESM/NodeNext), Node ≥22.13, Docker Compose, Hugging Face TEI (`ghcr.io/huggingface/text-embeddings-inference:cpu-latest`), `BAAI/bge-base-en-v1.5`, `node:test`.

## Global Constraints

- **No in-process embedder.** No ONNX runtime, no `onnxruntime-node`, no model weights in the API process. No new npm dependency at all.
- **No tuned constant changes value.** `GAP_CLUSTER_ASSIGN_THRESHOLD` (0.84), `QUESTIONNAIRE_MATCH_THRESHOLD` (0.84), `FLOW_ROUTER_MIN_SCORE` (0.25), `FLOW_ROUTER_MIN_MARGIN` (0.05) keep their values in code. Per-model guidance is published as documented overrides.
- **Never cast through `unknown` or `any`** to silence types (CLAUDE.md).
- **Validate as you go:** `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` per task — do not batch.
- **Run `npm run verify` before pushing** (`format:check`, `lint`, `deadcode` in STRICT mode, `typecheck`).
- **Workspace tests run as `npm test -w <pkg>`**, never root-cwd `node --test`.
- **This worktree needs its own `npm install`** before anything builds.
- **The correct env var is `EMBEDDING_TIMEOUT_MS`** (singular), per `apps/api/src/platform/config.ts:364`.
- **Docs are living specs** — `docs/retrieval.md` and `docs/ingestion.md` are updated alongside the code, not after.

## Sequencing note

Tasks 1–3 are pure application changes and are independently valuable — they let anyone point Magpie at any unauthenticated, non-1536-dimension embeddings endpoint (Ollama, LM Studio, an existing internal service) whether or not they use our compose profile. Task 4 ships the turnkey profile on top. Task 5 measures it, Task 6 documents it.

Task 4 has a **hard blocker**: the TEI licence check. Resolve it before starting that task, not at review time.

## File Structure

**Modify:**
- `packages/retrieval/src/embeddings.ts` — zero-padding, over-length rejection, conditional `Authorization` header.
- `packages/retrieval/src/embeddings.test.ts` — padding, cosine invariance, header behaviour.
- `apps/api/src/platform/providers.ts` — `embeddingProviderName` no longer requires a key; `createConfiguredEmbeddingProvider` passes an optional key.
- `apps/api/src/platform/config.ts` — startup log states when embeddings run unauthenticated.
- `docker-compose.yml` — the `embeddings` profile and its volume.
- `.env.compose.example`, `.env.example` — the sidecar variables and the override block.
- `docs/retrieval.md`, `docs/ingestion.md`, `.claude/skills/run-magpie/SKILL.md`.

**No new files.** Every change lands in something that already exists — a signal the design is using the existing seams rather than adding new ones.

---

### Task 1: Zero-pad embedding vectors to the stored width

`parseEmbeddingResponse` rejects any vector that is not exactly 1536 dimensions, which rules out every strong small local model. Zero-padding preserves cosine similarity exactly, so a 768-dimension model composes with the existing pgvector column, HNSW index, and every tuned threshold unchanged.

**Files:**
- Modify: `packages/retrieval/src/embeddings.ts` (`parseEmbeddingResponse`, ~lines 107–139)
- Modify: `packages/retrieval/src/embeddings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EmbeddingProvider.embed(texts: string[]): Promise<number[][]>` — unchanged signature; every returned vector is now exactly `EMBEDDING_DIMENSIONS` long regardless of the provider's native width. A provider returning **more** than `EMBEDDING_DIMENSIONS` throws.

- [ ] **Step 1: Write the failing tests**

Add to `packages/retrieval/src/embeddings.test.ts`, following the existing `fetch`-stubbing style in that file:

```typescript
test("pads a shorter provider vector to the stored dimension", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(768) }] }), {
      headers: { "content-type": "application/json" }
    })
  );

  const provider = new OpenAICompatibleEmbeddingProvider({
    apiKey: "k",
    baseUrl: "http://localhost:8080/v1",
    model: "BAAI/bge-base-en-v1.5"
  });
  const [vector] = await provider.embed(["hello"]);

  assert.equal(vector.length, EMBEDDING_DIMENSIONS);
  assert.deepEqual(vector.slice(768), new Array(EMBEDDING_DIMENSIONS - 768).fill(0));
});

test("padding leaves cosine similarity unchanged", () => {
  // The property the whole approach rests on: appended zeros add nothing to the
  // dot product and nothing to either norm, so every threshold tuned at 1536
  // behaves identically on a padded 768-dimension vector.
  const a = [3, 4, 0];
  const b = [4, 3, 0];
  const cosine = (x: number[], y: number[]): number => {
    const dot = x.reduce((sum, value, index) => sum + value * y[index], 0);
    const norm = (v: number[]): number => Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
    return dot / (norm(x) * norm(y));
  };
  const pad = (v: number[]): number[] => [...v, ...new Array(10).fill(0)];

  assert.equal(cosine(pad(a), pad(b)), cosine(a, b));
});

test("rejects a provider vector wider than the stored dimension", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(3072) }] }), {
      headers: { "content-type": "application/json" }
    })
  );

  const provider = new OpenAICompatibleEmbeddingProvider({
    apiKey: "k",
    baseUrl: "http://localhost:8080/v1",
    model: "too-wide"
  });
  await assert.rejects(() => provider.embed(["hello"]), /3072.*1536/s);
});
```

`vectorOf` already exists in this test file. Check its signature and reuse it.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w packages/retrieval -- --test-name-pattern="pads a shorter|wider than the stored"
```

Expected: the padding test FAILS with the existing `returned a 768-dim vector; expected 1536` error. The cosine test passes already — it asserts a mathematical property, and it is here as executable justification for the design, not as a driver.

- [ ] **Step 3: Implement padding**

In `packages/retrieval/src/embeddings.ts`, replace the dimension check inside `parseEmbeddingResponse`:

```typescript
  return ordered.map((entry) => {
    const vector = entry.embedding;
    if (!vector || vector.length === 0) {
      throw new Error("Embedding provider returned an empty vector");
    }
    if (vector.length > EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding provider returned a ${vector.length}-dim vector; the store holds ${EMBEDDING_DIMENSIONS} dimensions. ` +
          `Choose a model with at most ${EMBEDDING_DIMENSIONS} dimensions.`
      );
    }
    return padToStoredDimensions(vector);
  });
```

And add, near `EMBEDDING_DIMENSIONS`:

```typescript
// Vectors are stored in a fixed-width pgvector column, but good local models emit
// 384 or 768 dimensions. Zero-padding to the stored width is exact, not an
// approximation: appended zeros contribute nothing to a dot product and nothing to
// either vector's norm, so cosine similarity — and therefore every tuned threshold
// and every ranking — is identical to what the model produces natively.
//
// The alternative, making the column dimension configurable, would fragment the
// schema per deployment, which an append-only migrator with no rollback handles
// badly. The cost here is storage: 2x for a 768-dimension model.
function padToStoredDimensions(vector: number[]): number[] {
  if (vector.length === EMBEDDING_DIMENSIONS) {
    return vector;
  }
  return [...vector, ...new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w packages/retrieval
```

Expected: PASS, including the pre-existing tests that assert `vectors[0].length === EMBEDDING_DIMENSIONS` — still true, now by padding rather than by rejection.

- [ ] **Step 5: Validate**

```bash
npm run build && npm run typecheck && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/retrieval/src/embeddings.ts packages/retrieval/src/embeddings.test.ts
git commit -m "feat(embeddings): zero-pad shorter provider vectors to the stored dimension"
```

---

### Task 2: Optional API key for unauthenticated endpoints

TEI needs no credential. Today the only way to reach it is a fake API key, because provider selection demands one. That is exactly the workaround CLAUDE.md rules out, so the gate moves rather than the config.

**Files:**
- Modify: `packages/retrieval/src/embeddings.ts` (`OpenAICompatibleEmbeddingProvider`, `createEmbeddingProvider`)
- Modify: `packages/retrieval/src/embeddings.test.ts`
- Modify: `apps/api/src/platform/providers.ts` (`embeddingProviderName`, `createConfiguredEmbeddingProvider`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `OpenAICompatibleEmbeddingProvider` accepts `apiKey?: string`; the `Authorization` header is omitted entirely when unset.
  - `embeddingProviderName(config)` returns `"openai-compatible"` when `baseUrl` **and** `model` are set, regardless of key.
  - Azure is untouched — it requires `api-key` and there is no unauthenticated Azure.

- [ ] **Step 1: Write the failing tests**

In `packages/retrieval/src/embeddings.test.ts`:

```typescript
test("omits the Authorization header when no API key is configured", async (t) => {
  let sentHeaders: Headers | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(768) }] }), {
      headers: { "content-type": "application/json" }
    });
  });

  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "http://embeddings:80/v1",
    model: "BAAI/bge-base-en-v1.5"
  });
  await provider.embed(["hello"]);

  assert.equal(sentHeaders?.has("authorization"), false, "no key configured means no Authorization header");
});

test("sends the Authorization header when an API key is configured", async (t) => {
  let sentHeaders: Headers | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentHeaders = new Headers(init.headers);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(1536) }] }), {
      headers: { "content-type": "application/json" }
    });
  });

  const provider = new OpenAICompatibleEmbeddingProvider({
    apiKey: "secret",
    baseUrl: "https://api.example.com/v1",
    model: "text-embedding-3-small"
  });
  await provider.embed(["hello"]);

  assert.equal(sentHeaders?.get("authorization"), "Bearer secret");
});
```

And in `apps/api/src/platform/providers.ts`'s test file (create the test alongside the existing provider tests if one exists; otherwise add these cases to `apps/api/src/platform/config.test.ts`):

```typescript
test("selects openai-compatible embeddings without an API key", () => {
  const config = buildConfig({
    embeddings: {
      openAiCompatible: {
        embeddingBaseUrl: "http://embeddings:80/v1",
        embeddingModel: "BAAI/bge-base-en-v1.5"
      },
      azureOpenAi: {}
    }
  });
  assert.equal(embeddingProviderName(config), "openai-compatible");
});

test("does not select openai-compatible embeddings without a model", () => {
  const config = buildConfig({
    embeddings: { openAiCompatible: { embeddingBaseUrl: "http://embeddings:80/v1" }, azureOpenAi: {} }
  });
  assert.equal(embeddingProviderName(config), undefined);
});
```

Match `buildConfig` to whatever fixture helper that test file already uses for `AppConfig`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w packages/retrieval -- --test-name-pattern="Authorization header"
npm test -w apps/api -- --test-name-pattern="without an API key"
```

Expected: the first FAILS to compile or sends `Bearer undefined`; the second FAILS because `embeddingProviderName` returns `undefined` without a key.

- [ ] **Step 3: Make the key optional in the provider**

In `packages/retrieval/src/embeddings.ts`:

```typescript
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    // apiKey is optional: unauthenticated OpenAI-compatible embedding servers are
    // common (a local sidecar, an internal service on a trusted network), and
    // sending a credential such an endpoint ignores was never meaningful.
    private readonly config: Required<Pick<EmbeddingProviderConfig, "baseUrl" | "model">> &
      Pick<EmbeddingProviderConfig, "apiKey">,
    private readonly timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetchWithTimeout(
      `${trimTrailingSlash(this.config.baseUrl)}/embeddings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Omitted entirely when unset — never sent as "Bearer undefined".
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.config.model, input: texts })
      },
      this.timeoutMs,
      "Embedding provider"
    );

    return parseEmbeddingResponse(response, texts.length);
  }
}
```

In `createEmbeddingProvider`, drop the `assertConfig(config.apiKey, "OPENAI_COMPATIBLE_API_KEY")` line for the openai-compatible branch and pass `apiKey` straight through. Keep both Azure assertions.

- [ ] **Step 4: Move the selection gate**

In `apps/api/src/platform/providers.ts`:

```typescript
export function embeddingProviderName(config: AppConfig): EmbeddingProviderName | undefined {
  const oai = config.embeddings.openAiCompatible;
  const azure = config.embeddings.azureOpenAi;
  // No apiKey requirement: an unauthenticated endpoint is a legitimate
  // configuration, so a base URL and a model are what actually identify one.
  if (embeddingBaseUrl(config) && oai.embeddingModel) {
    return "openai-compatible";
  }
  if (azure.endpoint && azure.apiKey && azure.embeddingDeployment) {
    return "azure-openai";
  }
  return undefined;
}
```

`createConfiguredEmbeddingProvider` already spreads `apiKey: embeddingApiKey(config) || azure.apiKey`, which is `undefined` when neither is set — no change needed there beyond confirming it type-checks against the loosened constructor.

- [ ] **Step 5: Log the unauthenticated case at startup**

A deployment that *intended* to authenticate but omitted the key now proceeds keyless rather than falling back to keyword mode. Make that visible. In `apps/api/src/platform/config.ts`, where the resolved configuration is logged at startup, add a warning when `embeddingProviderName(config) === "openai-compatible"` and no embedding API key is set:

```
embeddings endpoint configured without an API key — requests will be unauthenticated
```

Match the surrounding log call's style and field naming exactly; do not introduce a new logger.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -w packages/retrieval && npm test -w apps/api
```

- [ ] **Step 7: Validate**

```bash
npm run build && npm run typecheck && npm run lint && npm run deadcode
```

Expected: green. If `assertConfig` is now only used by the Azure branch it is still used — do not remove it.

- [ ] **Step 8: Commit**

```bash
git add packages/retrieval/src apps/api/src/platform
git commit -m "feat(embeddings): allow unauthenticated openai-compatible endpoints"
```

---

### Task 3: Confirm hybrid mode activates end to end

Tasks 1 and 2 are only worth anything if `retrievalMode()` actually flips to `hybrid` in the new configuration. This is a small task, and it exists because that is the single assertion that proves the two preceding ones composed.

**Files:**
- Modify: `apps/api/src/platform/config.test.ts` (or the providers test file used in Task 2)

**Interfaces:**
- Consumes: `embeddingProviderName` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the test**

```typescript
test("reports hybrid retrieval for a keyless local endpoint with a Postgres store", () => {
  const config = buildConfig({
    embeddings: {
      openAiCompatible: {
        embeddingBaseUrl: "http://embeddings:80/v1",
        embeddingModel: "BAAI/bge-base-en-v1.5"
      },
      azureOpenAi: {}
    },
    stores: { knowledgeStore: "postgres" }
  });
  const { mode } = retrievalMode(config);
  assert.equal(mode, "hybrid");
});
```

Match `buildConfig`'s shape to the fixture helper in that file — in particular how it expresses the knowledge-store backend, which `retrievalMode` reads via `storeBackend(config, "KNOWLEDGE_STORE")`.

- [ ] **Step 2: Run it**

```bash
npm test -w apps/api -- --test-name-pattern="hybrid retrieval for a keyless"
```

Expected: PASS immediately. If it fails, Task 2 is incomplete — fix Task 2 rather than adjusting this assertion.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/platform
git commit -m "test(retrieval): cover hybrid mode for a keyless local embeddings endpoint"
```

---

### Task 4: The compose profile

**BLOCKER — resolve before starting:** confirm the licence terms of `ghcr.io/huggingface/text-embeddings-inference` for the tag being pinned permit redistribution in our compose file. TEI has not always been Apache-2.0. If the terms do not permit it, stop and report — the application changes in Tasks 1–3 stand on their own and operators can still point at their own endpoint.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.compose.example`
- Modify: `.env.example`

**Interfaces:**
- Consumes: the keyless, padding-tolerant provider from Tasks 1–2.
- Produces: a compose service named `embeddings` on profile `embeddings`, reachable at `http://embeddings:80/v1` on the compose network.

- [ ] **Step 1: Verify the licence**

Check the licence for the pinned tag. Record the finding in the commit message. Do not proceed if it does not permit redistribution.

- [ ] **Step 2: Add the service**

In `docker-compose.yml`, after the `postgres` service and before the logging block:

```yaml
  # --- Optional local embeddings (profile: embeddings) ---------------------
  # OPTIONAL. Serves an OpenAI-compatible /v1/embeddings so the API's existing
  # openai-compatible embedding provider can use it with no adapter — semantic
  # retrieval without a third-party account or API key.
  #
  # Quality is BELOW a hosted embedding model; see docs/retrieval.md for the
  # measured comparison. This does NOT make Magpie air-gap capable: TEI
  # downloads model weights on first start. For an air-gapped host, pre-populate
  # the cache volume or bake the weights into an image.
  #
  # Opt in with `--profile app --profile embeddings`, and set the
  # OPENAI_COMPATIBLE_EMBEDDING_* variables (see .env.compose.example).
  embeddings:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-latest
    command: ["--model-id", "BAAI/bge-base-en-v1.5", "--port", "80"]
    environment:
      HF_HOME: /data
    volumes:
      # Persists downloaded weights so a restart does not re-download ~440MB.
      - embeddings-cache:/data
    profiles:
      - embeddings
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:80/health"]
      interval: 10s
      timeout: 5s
      # Generous: the first start downloads and loads the model.
      retries: 30
      start_period: 60s
    restart: unless-stopped
```

Add `embeddings-cache:` to the top-level `volumes:` block.

Verify the healthcheck before committing — confirm TEI's health route and that `curl` exists in the image. If it does not, use a shell-based TCP check instead of adding a dependency to the image.

**Do not** add `depends_on: embeddings` to the `api` service. `api` is on the `app` profile and `embeddings` is not; a hard dependency would break `--profile app` on its own. The API already degrades to keyword mode when the endpoint is unreachable, and the background embedder retries — so a slow-starting sidecar is self-correcting.

- [ ] **Step 3: Add the variables**

In `.env.compose.example`, with a comment block:

```bash
# --- Optional local embeddings (compose profile: embeddings) -------------
# Uncomment to route embeddings at the bundled TEI sidecar instead of a hosted
# provider. Requires `--profile embeddings`. No API key: the sidecar is
# unauthenticated on the compose network.
#OPENAI_COMPATIBLE_EMBEDDING_BASE_URL=http://embeddings:80/v1
#OPENAI_COMPATIBLE_EMBEDDING_MODEL=BAAI/bge-base-en-v1.5
# Cold CPU inference is slower than a hosted endpoint.
#EMBEDDING_TIMEOUT_MS=60000
```

Mirror the same block in `.env.example` next to the existing `OPENAI_COMPATIBLE_EMBEDDING_*` entries (around line 292), pointing at `http://localhost:8080/v1` for host-based development rather than the compose hostname.

- [ ] **Step 4: Bring it up and verify**

```bash
docker compose --profile app --profile embeddings up -d
```

Then confirm the endpoint answers with the expected width:

```bash
curl -s http://localhost:4000/api/config | grep -o '"retrievalMode":"[a-z]*"'
```

Expected: `"retrievalMode":"hybrid"`. Match the actual field name to what `apps/api/src/features/config/service.ts` returns.

- [ ] **Step 5: Confirm sections acquire vectors**

```bash
docker compose exec postgres psql -U postgres -d markdown_magpie -c "SELECT embedding_model, count(*) FROM document_sections GROUP BY 1"
```

Expected: a row for `openai-compatible:BAAI/bge-base-en-v1.5` with a non-zero count, growing as the background embedder works through the corpus.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.compose.example .env.example
git commit -m "feat(compose): optional local embeddings sidecar behind the embeddings profile"
```

Record the licence finding from Step 1 in the commit body.

---

### Task 5: Measure it

The spec's justification rests on a number nobody has yet: how much retrieval quality bge-base costs versus a hosted model, and how much it buys over keyword-only. Producing that number is the deliverable of this task.

**Files:**
- Modify: `docs/retrieval.md` (the measured comparison)

**Interfaces:**
- Consumes: the running sidecar from Task 4.
- Produces: three golden-eval figures and a threshold sweep result.

- [ ] **Step 1: Establish the two baselines**

Run the golden eval per `docs/golden-eval.md` twice: once configured against `text-embedding-3-small` (the production reference), once with embeddings unconfigured (keyword mode — post-Spec-1 if that work has landed; note which, since the comparison is meaningless without it).

- [ ] **Step 2: Run it against the sidecar**

Same eval, with the sidecar configured. Record all three figures together.

- [ ] **Step 3: Sweep the gap threshold**

```bash
npm run eval:gap-threshold
```

Run it against `bge-base-en-v1.5`. `scripts/eval-gap-threshold.ts` is fixture-driven against `text-embedding-3-small` today — point it at the sidecar and record the threshold at which the labelled must-not-merge pairs stop over-merging, exactly as the 0.84 default was derived (see the rationale at `apps/api/src/platform/config.ts:235`).

- [ ] **Step 4: Report honestly**

Add the three eval figures and the swept threshold to `docs/retrieval.md`. If bge-base's gain over keyword mode is small, say so — that is a finding about the model, and it argues for revisiting the model choice, not for hiding the number or changing the architecture.

- [ ] **Step 5: Commit**

```bash
git add docs/retrieval.md
git commit -m "docs(retrieval): measured comparison for the local embeddings sidecar"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/retrieval.md`
- Modify: `docs/ingestion.md`
- Modify: `.claude/skills/run-magpie/SKILL.md`

**Interfaces:**
- Consumes: everything above, including Task 5's measured numbers.
- Produces: no code.

- [ ] **Step 1: Update `docs/retrieval.md`**

- **R2/R17** — a local sidecar is now a supported way to have embeddings; keyword-only is a fallback, not the only option without an account.
- **Key constants** — note that `EMBEDDING_DIMENSIONS` is the *stored* width and that shorter provider vectors are zero-padded, with the cosine-invariance rationale.
- Add the **per-model override block** from Task 5:

  ```bash
  # Recommended overrides when using BAAI/bge-base-en-v1.5.
  # The code defaults are tuned for text-embedding-3-small, which remains the
  # production recommendation; these are NOT applied automatically.
  GAP_CLUSTER_ASSIGN_THRESHOLD=<swept value>
  QUESTIONNAIRE_MATCH_THRESHOLD=<swept value>
  EMBEDDING_TIMEOUT_MS=60000
  ```

  Fill in the swept values from Task 5. If the sweep showed the existing 0.84 holds for bge-base, say that explicitly rather than omitting the line.
- **Provenance** — add `docs/superpowers/specs/2026-08-11-local-embeddings-sidecar-design.md`.

- [ ] **Step 2: Update `docs/ingestion.md`**

Its constants table lists `EMBEDDING_DIMENSIONS` (~line 273). Note the padding behaviour and that index-time embedding against a local CPU sidecar is markedly slower than a hosted endpoint, so a first full index takes longer.

- [ ] **Step 3: Update the `run-magpie` skill**

Add the opt-in line to the launch recipe:

```bash
docker compose --profile app --profile embeddings up -d
```

State the first start is slow (weights download) and that omitting the profile leaves the stack in keyword mode.

- [ ] **Step 4: Verify**

```bash
npm run verify
```

Expected: green, including `format:check` over the changed markdown.

- [ ] **Step 5: Commit**

```bash
git add docs .claude/skills/run-magpie/SKILL.md
git commit -m "docs: local embeddings sidecar setup and per-model threshold overrides"
```

---

## Verification checklist

Before opening the PR:

- [ ] `npm run verify` passes.
- [ ] `npm test` passes.
- [ ] TEI licence confirmed to permit redistribution, and the finding is recorded.
- [ ] `docker compose --profile app --profile embeddings up -d` reaches `retrievalMode: hybrid`.
- [ ] `docker compose --profile app up -d` (no embeddings profile) still works unchanged.
- [ ] `document_sections.embedding_model` shows the sidecar's model id with a growing count.
- [ ] Golden-eval figures for all three configurations are recorded in `docs/retrieval.md`.
- [ ] No tuned constant changed value in code.
- [ ] The docs state plainly that this is lower quality than a hosted model and is not air-gap capable.
