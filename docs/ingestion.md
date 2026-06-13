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
6. Updates the API's runtime search index.
7. Persists documents and sections to Postgres when `STORAGE_BACKEND=postgres`.

## Search

```bash
curl -s 'http://localhost:4000/search?q=hotfix'
```

Search is currently lightweight keyword scoring. It is intentionally simple until the embedding/indexing adapter is wired in.

## Ask

`POST /ask` retrieves up to five indexed sections and passes them as context.

In `AI_EXECUTION_MODE=queue`, the retrieved sections are embedded in the `answer_question` job payload for the watcher.
