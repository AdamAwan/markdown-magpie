# Markdown Ingestion & Indexing

> **Status:** living spec (as-built). Source of truth for how Markdown Magpie reads its
> configured sources and destinations, parses Markdown into documents and sections,
> indexes the curated knowledge base, and keeps its vectors current through index-time
> embedding. Follows the [spec conventions](./README.md#conventions).

## Purpose

Turn a configured, git-backed corpus of Markdown into the searchable answer index. This
subsystem walks a flow's **destination** KB, parses each `.md` file into a document plus
heading-based sections, persists them, and (when an embedding provider is configured)
brings every section's vector up to date — incrementally, so an unchanged corpus costs
zero embedding calls. It owns everything up to and including a populated, embedded index;
**query-time** retrieval (the agentic loop, hybrid search fusion, flow routing) belongs to
[retrieval.md](./retrieval.md).

## Sources, destinations & flows

- **IN1** — Read sources are configured with `KNOWLEDGE_SOURCES`, curated KB destinations
  with `KNOWLEDGE_DESTINATIONS`, and the links between them with `KNOWLEDGE_FLOWS`.
  `SOURCE` / `DESTINATION` are accepted as single-value aliases. `KNOWLEDGE_REPOSITORIES`
  and `KNOWLEDGE_REPO_PATH` remain accepted as compatibility fallbacks when the explicit
  source/destination variables are unset.

  ```env
  MAGPIE_CHECKOUT_ROOT=.magpie/checkouts
  KNOWLEDGE_SOURCES=[{"id":"agent","name":"Agent Knowledge","kind":"agent"},{"id":"flowerbi","name":"FlowerBI Source","url":"https://github.com/danielearwicker/flowerbi.git","subpath":"src"}]
  KNOWLEDGE_DESTINATIONS=[{"id":"flowerbi-docs","name":"FlowerBI Docs","url":"https://github.com/AdamAwan/flowerbi-doc-test.git","subpath":"docs"}]
  KNOWLEDGE_FLOWS=[{"id":"flowerbi","name":"FlowerBI KB","sourceIds":["flowerbi"],"destinationId":"flowerbi-docs"}]
  ```

- **IN2** — A source's `kind` MUST be one of:

  | Kind | Shape | Role |
  | --- | --- | --- |
  | `local` | `{ "path": "knowledge-bases/product" }` | On-disk folder. |
  | `git` | `{ "url": "…repo.git", "subpath": "docs" }` | Remote repo (cloned into the checkout root). |
  | `internet` | `{ "kind": "internet", "url": "https://example.com/docs" }` or `"internet"` | Reference URL; fetchable only with `allowedHosts` (IN4). |
  | `agent` | `{ "kind": "agent" }` or `"agent"` | The executing agent's own knowledge. |

- **IN3** — Remote `git` sources and destinations MUST be cloned or fast-forward pulled
  into `MAGPIE_CHECKOUT_ROOT` during API startup. `subpath` scopes the useful folder
  inside the checkout (e.g. a `docs` directory); document ids are then relative to that
  subtree (IN12).

- **IN4** — An `internet` source is a **reference-only** prompt note by default. Adding
  `"allowedHosts": ["docs.example.com"]` lets the executing agent actually **fetch** pages
  from those hosts over https while drafting/verifying. Hostnames match **exactly** (no
  wildcards or subdomains), redirects are re-checked against the list, and every retrieval
  is logged by the watcher. Fetched web content is **untrusted input** to the drafting
  agent — keep the list strict (see [threat-model.md](./threat-model.md)).

- **IN5** — **Per-repository PAT overrides.** By default every HTTPS git operation
  authenticates with the host-matched default token (`GITHUB_TOKEN` for github.com,
  `AZURE_DEVOPS_PAT` for Azure DevOps). A `git` source or destination MAY override that
  default with its own PAT via a `tokenEnv` field — the **name** of an environment
  variable holding the token. Only the env var **name** is stored in config and carried
  through job payloads and the credential-free execution context; the secret itself never
  travels, so the referenced variable MUST be set on **both** the API and the watcher. The
  override applies to clone/fetch/push **and** to the repo's GitHub PR create / comment /
  poll / review calls, and works for GitHub Enterprise / self-hosted HTTPS remotes with no
  host default. SSH remotes and credential-embedded URLs authenticate on their own and
  ignore `tokenEnv`; `tokenEnv` is honoured on `git` repositories only (ignored on
  `local` / `internet` / `agent`).

## What gets indexed

- **IN6** — Indexing a flow indexes its **destination** KB, not the raw source. Raw
  sources (`agent`, `internet`, source repos, libraries, codebases) are used to draft and
  update the destination KB, but are **not** indexed as the answer corpus. `POST
  /api/knowledge/repositories/index` (`manage:knowledge`) resolves the flow's destination
  and indexes it:

  ```bash
  curl -s -X POST http://localhost:4000/api/knowledge/repositories/index \
    -H 'content-type: application/json' \
    -d '{"flowId":"flowerbi"}'
  ```

- **IN7** — A full index MUST perform, in order: (1) walk the repository for `.md` files
  (ignoring `.git` and `node_modules`); (2) read the current Git commit SHA when
  available; (3) parse frontmatter; (4) split each document into heading-based sections;
  (5) store documents and sections in the in-memory search index; (6) persist them to
  Postgres when `KNOWLEDGE_STORE=postgres`; (7) kick off background embedding of any
  sections whose embedding is `NULL` when an embeddings provider is configured (IN17).
  File reads/parses run through a bounded worker pool, but output ordering stays
  deterministic (results are written into a pre-sized array by original index).

- **IN8** — A file larger than `MAX_MARKDOWN_FILE_BYTES` (**5 MiB**) MUST be skipped with a
  warning rather than indexed, so one oversized file cannot blow up indexing.

- **IN9** — The repository's recorded branch follows a single **primary-branch
  precedence**: a configured `branch` wins, else the detected `origin/HEAD` default, else
  the current branch, else `"main"` — so a freshly-created checkout with no fetched
  `origin/HEAD` still indexes against a sensible branch.

## Markdown & frontmatter parsing

- **IN10** — `parseMarkdownDocument` splits a leading `---`-fenced frontmatter block from
  the body and reads it as simple `key: value` lines (no nested YAML). Recognised keys map
  to document metadata: `title` (falling back to the first `#` heading, else `"Untitled"`),
  `owner`, `status` (normalised to `active` unless `draft` / `deprecated` / `archived`),
  `last_verified`, `review_cycle_days` (integer, or dropped if malformed — `Number()`
  rejects trailing garbage), `tags`, and `related_docs` (inline `[a, b]` lists). Malformed
  values MUST be dropped, never silently coerced.

- **IN11** — `splitIntoSections` splits the body into sections at ATX (`#`…`######`)
  headings, **fence-aware** so a `#` inside a ``` / `~~~` code block is not treated as a
  heading. A heading with no body still emits a section (so it stays visible to
  retrieval); only a truly empty (heading-less, body-less) buffer is skipped. Each section
  carries its `heading`, full `headingPath` (the compacted ancestor heading stack), and an
  `anchor` derived by the single exported `slugify` rule over the joined heading path,
  de-duplicated within the document.

- **IN12** — Section and document ids are **deterministic**: a document id is
  `<repositoryId>:<path>` (path relative to the indexed subtree) and a section id is
  `<documentId>:<ordinal>`. The same section therefore keeps its id across re-indexes as
  long as its position in the document is unchanged — the property the carry-forward
  upsert (IN16) and incremental indexing (IN14) depend on.

## Advisory-heading detection

- **IN13** — `findAdvisoryHeadings` scans a document's headings (fence-aware like IN11,
  covering both ATX and setext `===`/`---` underline forms, and stripping frontmatter and
  closed-ATX trailing hashes) and returns every heading whose normalised words contain a
  blocklist term as a whole word/phrase (`recommendation`, `next steps`, `roadmap`,
  `implementation plan`, …), de-duplicated in first-seen order. A match is a **flag, never
  a failure**: documents this system produces should be factual and descriptive, so an
  advisory-register heading signals the draft is recommending in its own voice — but a
  document MAY legitimately describe a roadmap a source itself states. Consumers warn and
  surface; they MUST NOT reject. The capability lives in `@magpie/markdown`; its consumer
  today is the proposal **register-check** (drafting/publishing surface), not the indexer.

## Document & section storage

- **IN14** — Documents and sections are held in an in-memory index for search and, when
  `KNOWLEDGE_STORE=postgres`, persisted to Postgres (`documents` / `document_sections`).
  A stored section row carries `id`, `document_id`, `path`, `heading`, `heading_path`,
  `anchor`, `ordinal`, `content`, and — once embedded — an `embedding` vector plus an
  `embedding_model` stamp (IN19). Uploaded Markdown (`indexMarkdownDocuments`) follows the
  same parse → split → store path with a synthetic repository id.

## Incremental & branch-aware re-indexing

- **IN15** — Each index request MUST pick a strategy via `chooseIncremental`, returning:
  **`full`** whenever incremental cannot be proven safe (not a git work tree, no resolvable
  HEAD, uncommitted working-tree changes, no prior indexed SHA, or the prior commit is
  unreachable after a force-push/rebase); **`noop`** when HEAD equals the last indexed SHA
  and the repo is already populated; otherwise **`incremental`** with the Markdown diff
  between the prior SHA and HEAD (`listChangedMarkdown`, scoped to the indexed subtree's
  pathspec).

- **IN16** — An incremental index MUST apply only the changed files: added/modified/copied
  and rename-targets are re-read and upserted; deletes and rename-sources leaving the
  subtree drop their document (and its sections). Unchanged documents are left exactly as
  they are — their stored `commitSha` stays at whatever commit last changed them; only
  re-read documents take the new head SHA. Changes outside the indexed subtree are ignored;
  an upsert wins over a delete for the same id within one tick.

- **IN17** — **Embedding carry-forward on re-index.** Both the full-repository re-index and
  the incremental delta MUST persist sections with an **upsert keyed on the section id**
  (never delete-and-reinsert):
  - A section whose `content` **and** `heading` are byte-identical to the stored row keeps
    its existing embedding (and `embedding_model` stamp) — the vector already paid for is
    carried forward, so an unchanged section is never re-embedded.
  - A section whose content or heading changed has its embedding **and** stamp reset to
    `NULL`, so the background embedder (which targets `embedding IS NULL`, IN18) recomputes
    exactly the changed sections — a one-line edit in a many-section document re-embeds only
    the sections it touched.
  - Sections absent from the new set are deleted, so nothing stale survives.

  The upshot: re-indexing a corpus that hasn't changed — a common trigger, since every
  merge cascade, publish pre-flight, dirty checkout, or plain-directory destination forces
  a full re-index — costs **zero** embedding calls.

## Index-time embedding (the background embedder)

- **IN18** — After an index or upload request returns, the API MUST spawn a **background**
  task that embeds any sections whose embedding is `NULL`, in batches (default 64),
  idempotently — only un-embedded sections are processed, so retries and partial failures
  are safe. This runs **inside the API process**: it is neither an inline chat call nor a
  queued watcher job, and there is no `embed_sections` job type. (Index-time embedding is
  the sanctioned in-API exception to the queue-only AI rule; see [ai-jobs.md](./ai-jobs.md)
  and [retrieval.md#R3](./retrieval.md).)

- **IN19** — The embedder MUST **coalesce**: a `trigger()` while a pass is in flight sets a
  rerun flag rather than starting a second pass, and the in-flight pass loops again to pick
  up work that arrived meanwhile. A provider batch returning a vector count that does not
  match the section count MUST be refused (the whole batch is rejected) rather than writing
  a misaligned batch. The store writes one multi-row update per provider batch.

- **IN20** — **Embedding-model versioning.** Vectors from different embedding models (or
  dimensions) are not comparable, so every stored section vector MUST carry an
  `embedding_model` stamp identifying the model that produced it
  (`openai-compatible:<model>` or `azure-openai:<deployment>`; see `embeddingModelId`):
  - **Query-time guard**: vector search only matches sections whose stamp equals the
    configured model, so a model switch can never fuse similarities across two vector
    spaces. Until re-embedding catches up, unmatched sections stay reachable via keyword
    search.
  - **Re-embed on change**: a section whose stamp differs from the configured model counts
    as "needing embedding", exactly like a content change — the same background embedder
    recomputes and re-stamps it.
  - **Startup kick**: because a model change (an env edit + restart) invalidates vectors
    with no re-index to notice it, the API also triggers the embedder once at startup.
  - **Upgrade adoption**: vectors persisted before the stamp existed are `NULL`-stamped; at
    startup the API adopts them under the configured model (they can only have been produced
    by whatever was configured when computed) instead of paying a full-corpus re-embed.
  - The carry-forward upsert (IN17) moves the stamp with the vector — carried forward when
    the vector is, cleared to `NULL` when it resets.

- **IN21** — Embeddings MUST come from an admin-configured endpoint; a CLI agent (Claude,
  Codex) cannot produce embeddings for this purpose. **Query-time** embedding (embedding
  the user's question, memoised in a bounded per-index LRU) is a separate synchronous
  concern owned by [retrieval.md#R2](./retrieval.md), not this subsystem.

## Embedding configuration

- **IN22** — An embedding endpoint is detected by the **presence of its credential
  variables** — set the full set for whichever provider you use:

  | Variable | Purpose |
  | --- | --- |
  | `KNOWLEDGE_STORE=postgres` + `DATABASE_URL` | Required for vector search. |
  | `OPENAI_COMPATIBLE_EMBEDDING_MODEL` (+ base URL & API key) | OpenAI-compatible embeddings. Model must output 1536-dim vectors. |
  | `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Azure OpenAI embeddings. Deployment must output 1536-dim vectors. |

- **IN23** — Embeddings are configured **independently of chat**, so one provider MAY
  answer questions while another embeds (e.g. DeepSeek for `/api/ask`, OpenAI for
  embeddings). The OpenAI-compatible embedding endpoint resolves
  `OPENAI_COMPATIBLE_EMBEDDING_BASE_URL` / `OPENAI_COMPATIBLE_EMBEDDING_API_KEY`, each
  falling back to the shared chat values (`OPENAI_COMPATIBLE_BASE_URL` /
  `OPENAI_COMPATIBLE_API_KEY`) when blank; setting `OPENAI_COMPATIBLE_EMBEDDING_MODEL` is
  what enables it. Both `text-embedding-3-small` and `ada-002` produce 1536-dim vectors and
  are compatible. `EMBEDDING_PROVIDER` is **informational only** — surfaced in `/api/config`
  for display, it does not enable embeddings.

- **IN24** — Hybrid retrieval activates automatically when `KNOWLEDGE_STORE=postgres` **and**
  a complete embedding credential set is configured; otherwise the system stays on
  keyword-only search with no change in API shape. `GET /api/config` MUST report the
  resolved `retrieval.mode` (`hybrid` or `keyword`) with a plain-language `reason`.

## The index search surface

- **IN25** — `GET /api/knowledge/search?q=…` (`read:knowledge`) is this subsystem's direct
  search over the indexed destination KB. When both `KNOWLEDGE_STORE=postgres` and an
  embeddings provider are configured it is **hybrid** — a pgvector nearest-neighbour search
  fused with an in-memory keyword scorer (heading match +3, content match +1) via Reciprocal
  Rank Fusion, results carrying a `[0,1]` relevance score; otherwise it falls back to
  keyword-only with the same API shape. A vector-search error degrades to keyword-only
  rather than failing the request. The agentic `POST /api/ask` and `POST /api/retrieve`
  answer path is specified in [retrieval.md](./retrieval.md).

## HTTP endpoints

- `POST /api/knowledge/repositories/index` — `{flowId? | localPath? | repositoryId?, name?}`
  → index summary (`manage:knowledge`, rate tier `trigger`). A resolution failure is a 400
  with a specific error code (`configured_repository_not_indexable`, `local_path_outside_root`,
  …); an indexing failure bubbles up as a 500.
- `GET /api/knowledge/search?q=…&limit?` → `{sections[], ranked[]}` (`read:knowledge`).
- `GET /api/knowledge/sections/:id` → `{section}`, 404 if absent (`read:knowledge`).
- `GET /api/knowledge/repositories`, `GET /api/knowledge/documents` (paginated),
  `GET /api/knowledge/stats`, `GET /api/knowledge/flows` (`read:knowledge`).

See [api.md](./api.md) for the full request/response reference.

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `MAX_MARKDOWN_FILE_BYTES` | 5 MiB | `apps/api/src/stores/knowledge-index.ts` |
| embedder `DEFAULT_BATCH_SIZE` | 64 | `apps/api/src/stores/embed-sections.ts` |
| `EMBEDDING_DIMENSIONS` | 1536 | `packages/retrieval/src/embeddings.ts` |
| keyword scorer weights | heading +3 / content +1 | `apps/api/src/stores/knowledge-index.ts` |

## Code map

| Concern | Code |
| --- | --- |
| Markdown / frontmatter parse, section split, slugify | `packages/markdown/src/index.ts` |
| Advisory-heading detection | `packages/markdown/src/advisory.ts` (consumer: `apps/api/src/features/proposals/register-check.ts`) |
| In-memory index, full / incremental / branch strategy, index search | `apps/api/src/stores/knowledge-index.ts` |
| Changed-Markdown diff (incremental input) | `packages/git/src/index.ts` (`listChangedMarkdown`, `diffChangedFiles`) |
| Postgres persistence + carry-forward upsert + stamp adoption | `apps/api/src/stores/postgres-knowledge-store.ts` |
| Index-time background embedding | `apps/api/src/platform/background-embedder.ts`, `apps/api/src/stores/embed-sections.ts` |
| Index endpoint (enqueue-free) & search | `apps/api/src/features/knowledge/{routes,service}.ts` |
| Repository resolution / checkout at startup | `apps/api/src/platform/repositories.ts`, `apps/api/src/stores/knowledge-repositories.ts` |
| Embedding provider + model id / retrieval mode | `apps/api/src/platform/providers.ts` |

## Tests (behavioural contract)

`packages/markdown/src/{index,advisory}.test.ts`,
`packages/git/src/changed-markdown.test.ts`,
`apps/api/src/stores/{knowledge-index,knowledge-index-incremental,knowledge-index-branch,embed-sections,postgres-knowledge-store,knowledge-repositories}.test.ts`,
`apps/api/src/features/knowledge/routes.test.ts`,
`apps/api/src/features/proposals/register-check.test.ts`,
`apps/api/src/platform/source-descriptors.test.ts`,
`apps/api/src/features/config/*` (retrieval-mode reporting).

## Provenance (design history)

Consolidates, and supersedes as a behavioural description:
`docs/superpowers/specs/2026-06-13-vector-hybrid-retrieval-design.md` (the vector/hybrid
substrate and index-time embedding — its **queued** index-time embedding is **stale**; the
work now runs in the in-API `BackgroundEmbedder`, IN18),
`2026-07-06-local-git-flow-mode-design.md` (source/destination/flow model, plain-directory
destinations, `tokenEnv`), `2026-07-06-source-agentic-grounding-design.md` (internet-source
`allowedHosts` fetching, IN4),
`2026-06-23-watcher-git-readiness-and-checkout-design.md` and
`2026-06-30-checkout-concurrency-design.md` (startup clone/pull into the checkout root,
IN3). Query-time embedding and hybrid-retrieval fusion are specified in
[retrieval.md](./retrieval.md).
