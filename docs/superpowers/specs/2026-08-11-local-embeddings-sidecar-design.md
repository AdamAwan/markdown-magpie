# Local embeddings sidecar

Status: proposed (2026-08-11)

Spec 2 of 2. Spec 1 (`2026-08-11-keyword-retrieval-quality-design.md`) makes
keyword-only retrieval genuinely usable. This one makes "no embeddings" a state a
deployment can leave without buying an API key. The two are independent and neither
blocks the other.

## Problem

Semantic retrieval requires an embedding provider, and both supported providers
(`openai-compatible`, `azure-openai`) are remote endpoints needing an API key
(`packages/retrieval/src/embeddings.ts`). A deployment without one runs in keyword
mode: no vector leg, no RRF, and embedding-first flow routing falls back to the chat
router (`docs/retrieval.md` R8, R17). Gap clustering and questionnaire matching lose
their similarity signal too.

Local demos hit this every time. They run on a CLI chat provider — a subscription,
not an API key — so there is no key to give the embeddings client, and the demo
silently runs in the weakest configuration Magpie has. The same applies to any
deployment where calling a third-party embeddings endpoint is blocked by cost or
policy.

The gap between "no embeddings" and "embeddings" is not a missing feature. The
`EmbeddingProvider` abstraction and its `openai-compatible` implementation already
accept **any** endpoint speaking the OpenAI `/embeddings` shape. Three things stop
that from being usable today:

1. Nothing ships that serves such an endpoint locally.
2. `parseEmbeddingResponse` hard-rejects any vector that is not exactly 1536
   dimensions. Every strong small local model emits 384 or 768.
3. `embeddingProviderName()` requires an `apiKey` before it will select the
   openai-compatible provider, so an unauthenticated local server can only be used
   by inventing a fake key.

## Goal / non-goals

**Goal.** Let an operator turn on semantic retrieval with no third-party account, by
enabling one compose profile — and document honestly what that costs them in
retrieval quality and what it does not buy them.

**Non-goals.**

- **Not an in-process embedder.** No ONNX runtime, no `onnxruntime-node`, no model
  weights inside the API process. The API stays I/O-bound. If single-process
  deployment later proves necessary, that is a separate piece of work informed by
  whatever this one teaches us.
- **Not an air-gap solution.** TEI downloads weights on first start. Air-gapped
  operation needs a pre-populated cache volume or a pre-baked image; this spec
  documents that rather than pretending the profile delivers it.
- **Not a change to production defaults.** `text-embedding-3-small` remains the
  recommended production model. No tuned constant changes value.
- **Not multilingual.** `bge-base-en-v1.5` is English-only. Non-English corpora are
  a separate decision.

## Design

### 1. The sidecar

A new `embeddings` profile in `docker-compose.yml`, following the `logging` profile's
precedent as an explicitly optional block that the application does not depend on:

- Image `ghcr.io/huggingface/text-embeddings-inference:cpu-latest`, which serves an
  OpenAI-compatible `POST /v1/embeddings` directly — so no adapter, no new npm
  dependency, and no application code involved in the integration at all.
- `MODEL_ID=BAAI/bge-base-en-v1.5` (768 dimensions, ~440MB). Chosen over the
  small tier for retrieval quality closer to `text-embedding-3-small`, accepting the
  slower first start.
- A named volume for the Hugging Face cache, so a restart does not re-download.
- A healthcheck, with the `api` service's `depends_on` gating on it. Without this the
  background embedder starts issuing batches while the model is still loading.

Wiring is two variables — `OPENAI_COMPATIBLE_EMBEDDING_BASE_URL` pointing at the
service and `OPENAI_COMPATIBLE_EMBEDDING_MODEL` naming the model.

**Licence check required before merge.** TEI's licence has not always been
Apache-2.0. Confirm the current terms for the pinned tag permit redistribution in
our compose file before this ships.

### 2. Dimensions

`parseEmbeddingResponse` zero-pads returned vectors to `EMBEDDING_DIMENSIONS`, and
raises a clear configuration error for anything **longer** than 1536.

Zero-padding preserves cosine similarity *exactly*: appended zeros contribute
nothing to the dot product and nothing to either vector's norm, so every similarity,
threshold, and ranking behaves as it would at native width. The cost is storage —
2× for a 768-dimension model — accepted deliberately, because the alternative
(making the column dimension configurable) means per-deployment schema divergence,
which an append-only migrator with no rollback handles badly.

Nothing else changes. `embedding_model` stamping (migration 0052) already treats a
model change exactly like a content change: `listSectionsNeedingEmbedding` returns
every section whose vector came from a different model, and `searchByEmbedding`
filters on the configured model so stale vectors are invisible rather than
incomparable. Enabling the sidecar therefore re-embeds through the existing
background path, with no migration and no manual reindex.

### 3. Optional API key for local endpoints

`embeddingProviderName()` requires `baseUrl`, `apiKey`, and `model` together before
it will select the openai-compatible provider. TEI is unauthenticated, so today the
only way to reach it is a fake key — precisely the kind of workaround CLAUDE.md
rules out.

The API key becomes optional for openai-compatible **embeddings**: selection gates on
`baseUrl + model`, and `OpenAICompatibleEmbeddingProvider` omits the `Authorization`
header entirely when no key is configured, rather than sending `Bearer undefined`.

This is stated as general behaviour, not a TEI carve-out — unauthenticated
OpenAI-compatible embedding servers are common, and requiring a credential that the
endpoint ignores was never meaningful. It does mean a deployment that *intended* to
authenticate but omitted the key now proceeds keyless instead of falling back to
keyword mode. The startup config log should therefore state explicitly when the
embeddings endpoint is being used without authentication.

Chat providers are untouched.

### 4. Thresholds stay put; overrides get documented

Four tuned constants depend on the embedding model's similarity distribution:
`GAP_CLUSTER_ASSIGN_THRESHOLD` (0.84), `QUESTIONNAIRE_MATCH_THRESHOLD` (0.84),
`FLOW_ROUTER_MIN_SCORE` (0.25), `FLOW_ROUTER_MIN_MARGIN` (0.05). All four are
already env-overridable, and `apps/api/src/platform/config.ts` already documents
that they are model-specific.

**No code default changes.** Those values were derived for
`text-embedding-3-small`, which remains the production recommendation; retuning them
in code would change production behaviour to suit a local demo.

Instead, `scripts/eval-gap-threshold.ts` is re-run against `bge-base-en-v1.5` and
the results published as a documented per-model override block that an operator
enabling the profile applies wholesale. `EMBEDDING_TIMEOUT_MS` belongs in that block
too — cold CPU inference is slower than a hosted endpoint, and the default timeout
was set for the latter.

If the sweep shows bge-base needs a *lower* assignment threshold than 0.84, that is
a finding to publish, not a reason to change the shared default.

### 5. Documentation

`docs/ingestion.md` and `docs/retrieval.md` gain the profile, the model, the
override block, and the padding behaviour. The `run-magpie` skill gains the
one-line opt-in. All three must state plainly that this is lower-quality retrieval
than a hosted embedding model, and that it does not make Magpie air-gap capable.

## Testing

- **Unit** (`packages/retrieval/src/embeddings.test.ts`): a 768-dimension response is
  padded to 1536 with zeros; a >1536 response raises a configuration error; padding
  leaves cosine similarity between two vectors unchanged; no `Authorization` header
  is sent when no key is configured, and one is sent when there is.
- **Unit** (`apps/api/src/platform/config.test.ts` and a providers test): the
  openai-compatible embedding provider is selected with `baseUrl + model` and no key;
  `retrievalMode()` reports `hybrid` in that configuration given a Postgres store.
- **Manual** (`run-magpie`): bring the stack up with the profile, confirm
  `retrievalMode: hybrid`, confirm sections acquire vectors via the background
  embedder, ask a question whose wording does not overlap the source text.
- **Eval**: golden eval against the sidecar, reported against two baselines —
  `text-embedding-3-small` (how much quality the local model costs) and Spec 1's
  keyword mode (how much it buys over no embeddings at all). This number is the
  deliverable's actual justification and should be recorded in the docs.

## Risks

- **§3 relaxes a gate for every openai-compatible deployment**, not only local ones.
  A missing key now proceeds keyless rather than degrading to keyword mode.
  Mitigated by making it explicit in the startup config log.
- **TEI licence terms are unverified.** A blocker for bundling, not for the design.
- **bge-base's quality is unmeasured here.** The eval in §5 could show the gain over
  keyword mode is smaller than assumed. That would be a reason to revisit the model
  choice, not the architecture.
- **First start is slow** (~440MB download plus model load). The healthcheck keeps it
  correct; it will still feel slow the first time, which the docs should say.

## Open questions

None blocking. The TEI licence check and the threshold sweep are both verification
steps for the implementation plan, with defined outcomes either way.
