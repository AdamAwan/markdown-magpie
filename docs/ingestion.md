# Markdown Ingestion

Markdown Magpie reads raw source data and writes reviewed Markdown proposals to configured destinations.
Sources and destinations can be separate repositories, the same repository, or folders inside a repository.

## Source And Destination Configuration

Configure read sources with `KNOWLEDGE_SOURCES`, curated KB destinations with `KNOWLEDGE_DESTINATIONS`,
and links between them with `KNOWLEDGE_FLOWS`
(`SOURCE` and `DESTINATION` are accepted as single-value aliases):

```env
MAGPIE_CHECKOUT_ROOT=.magpie/checkouts
KNOWLEDGE_SOURCES=[{"id":"agent","name":"Agent Knowledge","kind":"agent"},{"id":"flowerbi","name":"FlowerBI Source","url":"https://github.com/danielearwicker/flowerbi.git","subpath":"src"}]
KNOWLEDGE_DESTINATIONS=[{"id":"flowerbi-docs","name":"FlowerBI Docs","url":"https://github.com/AdamAwan/flowerbi-doc-test.git","subpath":"docs"}]
KNOWLEDGE_FLOWS=[{"id":"flowerbi","name":"FlowerBI KB","sourceIds":["flowerbi"],"destinationId":"flowerbi-docs"}]
```

Supported source kinds:

- `local`: `{ "path": "knowledge-bases/product" }`
- `git`: `{ "url": "https://github.com/org/repo.git", "subpath": "docs" }`
- `internet`: `{ "kind": "internet", "url": "https://example.com/docs" }` or `"internet"`
- `agent`: `{ "kind": "agent" }` or `"agent"`

Remote git sources and destinations are cloned or fast-forward pulled into `MAGPIE_CHECKOUT_ROOT`
during API startup.
Use `subpath` when the useful folder is inside the checkout, such as a `docs` directory.

`KNOWLEDGE_REPOSITORIES` and `KNOWLEDGE_REPO_PATH` remain accepted as compatibility fallbacks when
the explicit source/destination variables are unset.

## Indexing

Index a configured flow. This indexes the destination KB, not the raw source:

```bash
curl -s -X POST http://localhost:4000/api/knowledge/repositories/index \
  -H 'content-type: application/json' \
  -d '{"flowId":"flowerbi"}'
```

The `/ask` endpoint and MCP tools retrieve from indexed destination KB documents. Raw sources
(`agent`, `internet`, source repos, libraries, codebases) are used to draft and update the
destination KB, but are not indexed as the answer corpus.

The API:

1. Walks the repository for `.md` files.
2. Ignores `.git` and `node_modules`.
3. Reads the current Git commit SHA when available.
4. Parses frontmatter.
5. Splits documents into heading-based sections.
6. Stores sections in the in-memory search index.
7. Persists documents and sections to Postgres when `KNOWLEDGE_STORE=postgres`.
8. Kicks off background embedding of any sections whose embedding is `NULL` (when an embeddings provider is configured).

## Search

```bash
curl -s 'http://localhost:4000/api/knowledge/search?q=hotfix'
```

When both `KNOWLEDGE_STORE=postgres` and an embeddings provider are configured, retrieval is **hybrid**: a pgvector nearest-neighbour search is fused with an in-memory keyword scorer (heading match +3, content match +1) using Reciprocal Rank Fusion (RRF). Results carry a `[0,1]` relevance score. When either condition is absent the system falls back to keyword-only scoring with no change in API shape.

The active retrieval mode is reported by `GET /api/config` under `retrieval.mode` (`hybrid` or `keyword`) along with a plain-language `reason`.

## Section Embeddings

After an index or upload request returns, the API spawns a background task that embeds any sections whose embedding is `NULL`. This is idempotent — only un-embedded sections are processed. There is no separate watcher or scheduled job for embedding; the work runs inside the API process.

Query-time embedding (embedding the user's question) is synchronous in the API request. This keeps latency predictable and avoids coordination between the API and any external agent.

Embeddings must come from an admin-configured endpoint. A CLI agent (Claude, Codex) cannot produce embeddings for this purpose.

## Embedding Configuration

An embedding endpoint is detected by the **presence of its credential variables** — set all three for whichever provider you use:

| Variable | Purpose |
|---|---|
| `KNOWLEDGE_STORE=postgres` + `DATABASE_URL` | Required for vector search. |
| `OPENAI_COMPATIBLE_EMBEDDING_MODEL` (+ base URL & API key) | OpenAI-compatible embeddings. The model must output 1536-dimensional vectors. |
| `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Azure OpenAI embeddings. The deployment must output 1536-dimensional vectors. |

Embeddings are configured **independently of chat**, so you can answer questions with one provider and embed with another (e.g. DeepSeek for `/api/ask`, OpenAI for embeddings). The embedding endpoint resolves its base URL and API key from `OPENAI_COMPATIBLE_EMBEDDING_BASE_URL` / `OPENAI_COMPATIBLE_EMBEDDING_API_KEY`, each falling back to the shared chat values (`OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_API_KEY`) when left blank. Setting `OPENAI_COMPATIBLE_EMBEDDING_MODEL` is what enables OpenAI-compatible embeddings.

`EMBEDDING_PROVIDER` is informational only — it is surfaced in `/api/config` for display and does not enable embeddings.

Both `text-embedding-3-small` and `ada-002` produce 1536-dimensional vectors and are compatible. Hybrid retrieval activates automatically when `KNOWLEDGE_STORE=postgres` **and** a complete set of embedding credentials (a resolved OpenAI-compatible base URL + API key + `OPENAI_COMPATIBLE_EMBEDDING_MODEL`, or the Azure trio above) are configured; otherwise the system stays on keyword-only search with no regression in behaviour. `/api/config` reports the resolved `retrieval.mode` (`hybrid` or `keyword`) and a plain-language `reason`.

## Ask

`POST /api/ask` is enqueue-only: it records the question log and enqueues an
`answer_question` job, returning `202` (see [api.md](api.md)). All generative
work runs in the watcher, which routes the question to a flow, calls
`POST /api/retrieve` for scoped context using the active retrieval mode (hybrid
or keyword), then synthesises the answer. Answer confidence is derived from the
relevance scores of the retrieved sections. The watcher completes the job, which
updates the question log with the answer, flow, and citations.
