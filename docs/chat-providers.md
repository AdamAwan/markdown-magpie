# Chat Providers

Answer synthesis runs on the **watcher**, not the API. The API never calls a
model inline: it enqueues an `answer_question` job, and a watcher configured with
a chat provider claims and completes it (see [ai-jobs.md](ai-jobs.md)).

`AI_PROVIDER` is mandatory and selects which provider the system routes work to.
Valid values: `openai-compatible`, `azure-openai`, `codex`, `claude`. A watcher
only advertises (and therefore claims) a provider's capability once that
provider's credentials are set in its environment, so the watcher must carry the
credentials matching the chosen `AI_PROVIDER`.

## Providers

### `openai-compatible`

Uses an OpenAI-compatible `/chat/completions` endpoint. The watcher advertises
this capability only when all three vars are set.

```bash
OPENAI_COMPATIBLE_BASE_URL=https://example.com/v1 \
OPENAI_COMPATIBLE_API_KEY=... \
OPENAI_COMPATIBLE_MODEL=... \
npm run dev:watcher
```

### `azure-openai`

Uses Azure OpenAI chat completions. The watcher advertises this capability when
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_CHAT_DEPLOYMENT`
are all set.

```bash
AZURE_OPENAI_ENDPOINT=https://example.openai.azure.com \
AZURE_OPENAI_API_KEY=... \
AZURE_OPENAI_CHAT_DEPLOYMENT=... \
AZURE_OPENAI_API_VERSION=2024-10-21 \
npm run dev:watcher
```

### `codex` / `claude`

Run an external agent CLI. The watcher advertises the `codex` capability when
`CODEX_CLI_PATH` is set and the `claude` capability when `CLAUDE_CLI_PATH` is
set (both default to a bare command resolved on `PATH`). CLI providers execute the
full non-embedding LLM job contract, including cited answers and gap
reconciliation; semantic embeddings still require an OpenAI-compatible or Azure
embedding endpoint.

```bash
CODEX_CLI_PATH=codex npm run dev:watcher   # or CLAUDE_CLI_PATH=claude
```

See [ai-jobs.md](ai-jobs.md) for the full job contract and capability model, and
`.env.example` for every supported variable.
