# Markdown Ingestion

Markdown Magpie indexes Git-backed Markdown repositories through the API.

## Local Repository Indexing

Configure one or more server-side knowledge bases in the API environment:

```env
KNOWLEDGE_REPOSITORIES=[{"id":"cats","name":"Cats Knowledge Base","path":"knowledge-bases/cats"},{"id":"docs","name":"Product Docs","path":"../product-docs"}]
```

Then index a configured repository by ID:

```bash
curl -s -X POST http://localhost:4000/repositories/index \
  -H 'content-type: application/json' \
  -d '{"repositoryId":"cats"}'
```

The API rejects arbitrary client-supplied local paths when `KNOWLEDGE_REPOSITORIES` is set.
`KNOWLEDGE_REPO_PATH` remains available as a legacy single-repository fallback when the
multi-repository variable is unset.

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
curl -s 'http://localhost:4000/search?q=hotfix'
```

When both `KNOWLEDGE_STORE=postgres` and an embeddings provider are configured, retrieval is **hybrid**: a pgvector nearest-neighbour search is fused with an in-memory keyword scorer (heading match +3, content match +1) using Reciprocal Rank Fusion (RRF). Results carry a `[0,1]` relevance score. When either condition is absent the system falls back to keyword-only scoring with no change in API shape.

The active retrieval mode is reported by `GET /config` under `retrieval.mode` (`hybrid` or `keyword`) along with a plain-language `reason`.

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

Embeddings are configured **independently of chat**, so you can answer questions with one provider and embed with another (e.g. DeepSeek for `/ask`, OpenAI for embeddings). The embedding endpoint resolves its base URL and API key from `OPENAI_COMPATIBLE_EMBEDDING_BASE_URL` / `OPENAI_COMPATIBLE_EMBEDDING_API_KEY`, each falling back to the shared chat values (`OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_API_KEY`) when left blank. Setting `OPENAI_COMPATIBLE_EMBEDDING_MODEL` is what enables OpenAI-compatible embeddings.

`EMBEDDING_PROVIDER` is informational only — it is surfaced in `/config` for display and does not enable embeddings.

Both `text-embedding-3-small` and `ada-002` produce 1536-dimensional vectors and are compatible. Hybrid retrieval activates automatically when `KNOWLEDGE_STORE=postgres` **and** a complete set of embedding credentials (a resolved OpenAI-compatible base URL + API key + `OPENAI_COMPATIBLE_EMBEDDING_MODEL`, or the Azure trio above) are configured; otherwise the system stays on keyword-only search with no regression in behaviour. `/config` reports the resolved `retrieval.mode` (`hybrid` or `keyword`) and a plain-language `reason`.

## Ask

`POST /ask` retrieves up to five indexed sections using the active retrieval mode (hybrid or keyword) and passes them as context. Answer confidence is derived from the relevance scores of the retrieved sections.

In `AI_EXECUTION_MODE=queue`, the retrieved sections are embedded in the `answer_question` job payload for the watcher.
