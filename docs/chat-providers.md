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

Each CLI provider also accepts:

- `CODEX_CLI_ARGS` / `CLAUDE_CLI_ARGS` — base args (default `exec` / `-p`).
- `CODEX_CLI_MODEL` / `CLAUDE_CLI_MODEL` — when set, `--model <value>` is appended
  to the args (the flag both CLIs share); leave unset to use the CLI's own default.
- `CODEX_CLI_PROMPT_MODE` / `CLAUDE_CLI_PROMPT_MODE` — `stdin` (default) pipes the
  prompt in; `arg` passes it as a CLI argument. Keep `stdin`: in `arg` mode a prompt
  above ~128 KB fails to spawn on Linux (`spawn E2BIG`) and one above the ~32 KB
  Windows command line fails with `spawn ENAMETOOLONG` — retrieval-augmented and
  source-grounded prompts reach both ([ai-jobs.md](ai-jobs.md) J80). Before this
  default changed, `arg` was the default.
- `AGENT_CLI_MAX_OUTPUT_BYTES` — cap on a run's captured stdout (default 8 MiB);
  crossing it stops the run. A timed-out or cancelled run is killed with its whole
  process tree (J85).

On Windows, set `*_CLI_PATH` to a directly-spawnable executable (e.g. `claude.exe`);
a `.cmd`/`.ps1` PATH shim cannot be spawned without a shell.

## Retries, truncation and errors

The two hosted providers retry a **transient** failure — HTTP 408, 429 or 5xx, a
timed-out attempt (`AGENT_API_TIMEOUT_MS` applies per attempt), or a dropped
connection — up to `AGENT_API_MAX_RETRIES` times (default 2), backing off
exponentially with jitter or for the provider's `Retry-After` / `retry-after-ms`,
whichever is longer. A `Retry-After` longer than 30 s is not waited out in-process;
the job fails and its queue retry picks it up later. Cancelling the job stops a
pending wait immediately. Other 4xx responses are never retried — they are
configuration or request errors ([ai-jobs.md](ai-jobs.md) J81).

A reply with `finish_reason: "length"` was cut off at the model's output-token limit.
It fails as a **truncation** (`ProviderOutputTruncatedError`) rather than being parsed:
raise the deployment's max output tokens if this recurs (J83).

Provider errors name the status and the provider's own short error message only —
never the raw response body, which can echo prompt text — with credential-shaped
tokens redacted (J82). The same typed error (`ProviderRequestError`: `status`,
`retryAfterMs`, `retryable`) is what the API's embedding calls throw; query-time
embedding calls additionally sit behind a short timeout and a circuit breaker so a
down embedding endpoint degrades retrieval to keyword-only within milliseconds
instead of stalling each ask (J86, see [retrieval.md](retrieval.md)).

## Sampling temperature

Both hosted providers (`openai-compatible` and `azure-openai`) send
`temperature: 0.2` by default. `CHAT_TEMPERATURE` on the watcher overrides that
for both:

| `CHAT_TEMPERATURE`     | Request body                       |
| ---------------------- | ---------------------------------- |
| unset (or unparseable) | `temperature: 0.2`                 |
| `default`              | field omitted entirely             |
| a number (e.g. `0.7`)  | `temperature: 0.7`                 |

Set it to `default` for **reasoning deployments** — GPT-5-class and o-series
models accept only their own temperature and reject any explicit value with
`HTTP 400 unsupported_value`, which otherwise makes the deployment unusable. The
value is deliberately configuration rather than a name heuristic: deployment
names are operator-chosen, so sniffing for `gpt-5`/`o1` breaks on any other
naming convention. This affects the chat-completions path only; the AI-SDK agent
model used for source-grounded jobs never sends a temperature.

## JSON responses

The `answer_question` flow's model calls (routing, the assess/answer step, and the
grounding verification) set `ChatRequest.responseFormat = "json"`. The
`openai-compatible` and `azure-openai` providers translate that to
`response_format: { type: "json_object" }`, so the endpoint returns syntactically
valid JSON — this closes the failure where a model embeds an unescaped quote in a
JSON string and the whole reply fails to parse. The endpoint must support
`response_format` (standard on OpenAI and virtually all compatible servers). CLI
providers (`codex`, `claude`) cannot enforce it and rely on the prompt (which always
demands JSON); as a final safety net the watcher never surfaces an unparsed,
JSON-shaped reply as an answer.

See [ai-jobs.md](ai-jobs.md) for the full job contract and capability model, and
`.env.example` for every supported variable.
