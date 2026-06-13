# Markdown Ingestion

Markdown Magpie indexes Git-backed Markdown repositories through the API.

## Local Repository Indexing

```bash
curl -s -X POST http://localhost:4000/repositories/index \
  -H 'content-type: application/json' \
  -d '{"localPath":"../markdown-magpie-kb"}'
```

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

| Variable | Purpose |
|---|---|
| `KNOWLEDGE_STORE=postgres` + `DATABASE_URL` | Required for vector search. |
| `EMBEDDING_PROVIDER` | `openai-compatible` or `azure-openai`. |
| `OPENAI_COMPATIBLE_EMBEDDING_MODEL` | Embedding model for the OpenAI-compatible endpoint. Must output 1536-dimensional vectors. |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Azure OpenAI embedding deployment name. Must output 1536-dimensional vectors. |

Both `text-embedding-3-small` and `ada-002` produce 1536-dimensional vectors and are compatible. Hybrid retrieval activates automatically when both `KNOWLEDGE_STORE=postgres` and an `EMBEDDING_PROVIDER` are configured; otherwise the system stays on keyword-only search with no regression in behaviour.

## Ask

`POST /ask` retrieves up to five indexed sections using the active retrieval mode (hybrid or keyword) and passes them as context. Answer confidence is derived from the relevance scores of the retrieved sections.

In `AI_EXECUTION_MODE=queue`, the retrieved sections are embedded in the `answer_question` job payload for the watcher.
