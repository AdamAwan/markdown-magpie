# Configuration reference (environment variables)

Every environment variable the code under `apps/`, `packages/` and `scripts/` reads, grouped
by area: where it is read, its default, and how much an operator should care about it.

This is a lookup reference, not a spec. [`.env.example`](../.env.example) is the annotated
template to copy; this file is the complete inventory, including variables that are too
niche for the template. When the two disagree with the code, the code wins — the
authoritative readers are listed under [Where configuration is read](#where-configuration-is-read).

## How to read the tables

**Class** says how likely you are to need the variable:

| Class | Meaning |
| --- | --- |
| **essential** | The process will not start, or the feature it belongs to cannot work, without it. "essential when …" means it becomes mandatory under the stated condition. |
| **common** | Most real deployments set or at least review it. |
| **tuning** | A knob with a sensible default that is rarely changed. Leave it unset unless you have a measured reason. |
| **dev/test** | Only meaningful for local development, CI, or the eval/e2e scripts. |
| **internal** | Set by the build, the runtime, or the code itself — not operator configuration. |

**Read by** names the process: `api`, `watcher`, `mcp` (both transports unless stated), `web`,
or a script. A variable read by several processes must be set in each one's environment —
with Docker Compose they all share `.env.compose.example` + `.env.compose`, so this is
automatic; on separately deployed watchers it is not.

**Blank means unset.** The API and watcher loaders treat `FOO=` exactly like an absent
`FOO`. Integer knobs validated by those loaders fail startup on a non-numeric value, as
do the knowledge/authorization JSON values described below;
the float knobs and the knobs read outside the loaders fall back to their default on a
bad value instead (noted per variable).

## Where configuration is read

| Process | Reader | Behaviour on bad input |
| --- | --- | --- |
| API | `apps/api/src/platform/config.ts` (`loadConfig`, zod schema, validated once at startup) | One aggregated error naming every offending variable; the API does not start. |
| API (knowledge) | `apps/api/src/stores/knowledge-repositories.ts` | Malformed JSON is reported at startup. |
| Watcher | `apps/watcher/src/config.ts` (`loadWatcherConfig`), `runners/index.ts` (provider settings), `capabilities.ts` (readiness gates), `health-server.ts` | Loader errors abort startup; provider knobs fall back to defaults. |
| MCP | `apps/mcp/src/http.ts`, `main.ts`, `kb-client.ts` | Fails fast on missing credentials when auth is on. |
| Web | `apps/web/src/app/layout.tsx` (runtime), `src/lib/api.ts` (build time), `next.config.mjs` | Missing values render as empty configuration. |
| Shared | `packages/auth`, `packages/git`, `packages/telemetry`, each app's `logger.ts` | See the relevant section. |

## Core services and networking

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | api, `scripts/migrate.mjs`, `scripts/eval-golden.ts` | — | **essential** | Postgres URL. Backs every store and the pg-boss job queue. Required by the API even with `STORAGE_BACKEND=memory`. |
| `STORAGE_BACKEND` | api | `memory` | **essential** in practice | `memory` \| `postgres`. Every real deployment sets `postgres`; the in-memory default loses all data on restart. |
| `PORT` | api (web via Next.js) | `4000` (api) | common | API listen port. Compose sets `4000` for the API and `3000` for the web container. |
| `API_BASE_URL` | watcher, mcp, `scripts/eval-api.ts` | `http://localhost:4000` | **essential** outside local dev | How the watcher and MCP server reach the API. The watcher refuses to start without it when auth is on. A trailing `/api` is stripped by mcp and the eval script. |
| `NEXT_PUBLIC_API_BASE_URL` | web (inlined at **build** time; also read at runtime by the server layout) | empty (same origin) | common | Browser-facing API URL. Takes precedence over `PUBLIC_API_BASE_URL`. |
| `PUBLIC_API_BASE_URL` | web (runtime) | empty (same origin) | common | Runtime fallback for a prebuilt image. Leave both blank when the API is served from the web app's origin. |
| `CORS_ALLOWED_ORIGINS` | api | `*` | common | Comma-separated origin allow-list. Restrict it in production. |
| `NODE_ENV` | api, watcher, mcp, web | `development` | common | `production` selects JSON logs at `info` and the `.next-build` output dir. The Docker image sets it. |
| `LOG_LEVEL` | api, watcher, mcp | `info` in production, else `debug` | common | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`. |
| `LOG_STARTUP_CONFIG` | api | on | tuning | Set exactly `false` to skip the resolved-configuration log at startup. Secrets are always masked. |
| `API_SHUTDOWN_DRAIN_MS` | api | `10000` | tuning | Longest the API waits for in-flight background work on SIGTERM/SIGINT. |
| `DB_POOL_MAX` | api | `10` | tuning | Connections in the shared store pool (pg-boss keeps its own pool). |
| `DB_IDLE_TIMEOUT_MS` | api | `30000` | tuning | Idle connection lifetime. |
| `DB_CONNECTION_TIMEOUT_MS` | api | `10000` | tuning | Fail if a connection cannot be acquired in time. |
| `DB_STATEMENT_TIMEOUT_MS` | api | `30000` | tuning | Server-side cap on a single statement. |

### Per-store backend overrides

Each of these takes `memory` \| `postgres` and defaults to `STORAGE_BACKEND`. They exist
for tests and partial local setups; a deployment sets `STORAGE_BACKEND=postgres` and leaves
them all unset. All are read by the API and are class **tuning**.

`KNOWLEDGE_STORE` (must resolve to `postgres` for hybrid/semantic retrieval),
`KNOWLEDGE_CHANGE_STORE`, `QUESTION_LOG_STORE`, `PROPOSAL_STORE`, `SCHEDULED_TASK_STORE`,
`SOURCE_SYNC_STORE`, `PATROL_STORE`, `GAP_CLUSTER_STORE`, `RECONCILIATION_DECISION_STORE`,
`MAINTENANCE_RUN_STORE`, `WATCHER_REGISTRY_STORE`, `PR_CROSSLINK_STORE`,
`GAP_CLOSURE_VERIFICATION_STORE`, `SOURCE_MAP_STORE`, `SOURCE_CONFLICT_STORE`,
`SEED_PLAN_STORE`, `QUESTIONNAIRE_STORE`, `ASSERTED_CLAIMS_STORE`,
`QUESTIONNAIRE_IMPORT_STORE`.

## Authentication and authorization

See [authorization.md](./authorization.md). Auth **fails closed**: it is on unless
`AUTH_REQUIRED` is exactly `false`.

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `AUTH_REQUIRED` | api, watcher, mcp | on | **essential** | Only the literal `false` (any case) disables auth. Unset, blank or a typo leaves it on. |
| `AUTH0_AUDIENCE` | api, watcher, mcp, web | placeholder `https://markdown-magpie.local/api` | **essential** when auth is on | The API identifier tokens must carry. The API and watcher refuse to start with the placeholder. |
| `AUTH0_DOMAIN` | api, watcher, mcp, web | — | **essential** when auth is on (or `AUTH0_ISSUER_BASE_URL`) | Issuer is derived as `https://<domain>/`. |
| `AUTH0_ISSUER_BASE_URL` | api, watcher, mcp | — | **essential** when auth is on (or `AUTH0_DOMAIN`) | Full issuer URL; takes precedence over `AUTH0_DOMAIN`. |
| `AUTH0_JWKS_URI` | api, mcp | `<issuer>.well-known/jwks.json` | tuning | Override the JWKS endpoint. |
| `AUTH_ROLES_CLAIM` | api, mcp | `https://magpie.wastedcake.com/roles` | common when flow-scoping is used | JWT claim carrying role names. |
| `KNOWLEDGE_ROLE_GRANTS` | api | unset (flow-scoping inactive) | common; **essential** with `AUTH_PROVIDER=entra` and auth on | JSON: role → flow id (or `*`) → capabilities (`read`/`manage`/`ask` per flow; `admin`/`ops` on `*` only). On Entra the API refuses to start without it, and admin/ops routes are authorized from these role grants rather than from delegated scopes ([AZ27/AZ28](./authorization.md#privileged-actions-when-scopes-are-not-per-user)). |
| `AUTH0_CLIENT_ID` | web (runtime) | empty | **essential** for the console when auth is on | SPA client id. |
| `AUTH0_REDIRECT_URI` | web (runtime) | `http://localhost:3000` | **essential** for a deployed console | SPA redirect URI. |
| `NEXT_PUBLIC_AUTH0_DOMAIN`, `NEXT_PUBLIC_AUTH0_CLIENT_ID`, `NEXT_PUBLIC_AUTH0_AUDIENCE`, `NEXT_PUBLIC_AUTH0_REDIRECT_URI` | web | empty | tuning | Optional overrides that take precedence over the `AUTH0_*` runtime values. Leave blank to keep one image configurable per deployment. |

### Service credentials

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `WATCHER_API_CLIENT_ID`, `WATCHER_API_CLIENT_SECRET` | watcher | — | **essential** when auth is on (or `API_TOKEN`) | Client-credentials pair; must be set together. Preferred — the token refreshes itself. |
| `API_TOKEN` | watcher | — | common (legacy) | Static pre-minted token; used only when the pair is unset. Expires. Must be a client-credentials (service) token: the job claim/heartbeat/complete/fail endpoints reject user tokens ([AZ29](./authorization.md)). |
| `MCP_API_CLIENT_ID`, `MCP_API_CLIENT_SECRET` | mcp (HTTP) | — | **essential** for HTTP MCP when auth is on (or `MCP_API_AUTH_TOKEN`) | The MCP server's own machine identity for calling the API. |
| `MCP_API_AUTH_TOKEN` | mcp (HTTP) | — | common (legacy) | Static alternative to the pair. Expires. |
| `MCP_AUTH_TOKEN` | mcp (stdio) | — | **essential** for stdio MCP when auth is on | Bearer token the stdio transport presents to the API. |

## Knowledge sources, destinations and flows

See [ingestion.md](./ingestion.md) and [flows-and-seeding.md](./flows-and-seeding.md).

The API validates these at startup (`knowledgeConfigIssues`,
`apps/api/src/stores/knowledge-repositories.ts`) and refuses to boot, naming the variable,
when a sources/destinations/flows/repositories value starts with `[` or `{` but is not
valid JSON, when a configured flow entry lacks a `destinationId` or any `sourceIds`, or
when a flow references a source or destination id that is not configured. (Such values
used to be silently re-read as a plain string or the flow silently dropped.) The
plain-string forms — a bare path, a git URL, `agent`, `internet` — are unaffected.

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `KNOWLEDGE_SOURCES` | api | `[]` | **essential** | JSON array of read-from sources. |
| `KNOWLEDGE_DESTINATIONS` | api | `[]` | **essential** | JSON array of written-to knowledge bases (the indexed answer corpus). |
| `KNOWLEDGE_FLOWS` | api | `[]` | **essential** | JSON array linking sources to a destination. |
| `MAGPIE_CHECKOUT_ROOT` | api, watcher | `.magpie/checkouts` | **essential** in containers | Managed clone root. Must be a writable volume; API and watcher each need one. Relative paths resolve from the working directory. |
| `MAGPIE_SNAPSHOT_ROOT` | api | `.magpie/snapshots` | **essential** in containers | Where per-flow snapshots are written. Must be writable. |
| `MAGPIE_LOCAL_INDEX_ROOT` | api | working directory | tuning | Root a client-supplied local index path must stay inside (path-traversal guard). |
| `SOURCE_SYNC_MAX_CHANGED_FILES` | api | `1000` | tuning | Changed files one source-sync run considers per source; the true total is still recorded on the run. Bad values fall back. |
| `SEED_BOOTSTRAP_MAX_DOCS` | api | `3` | tuning | A flow with fewer indexed documents than this is offered an auto-proposed seed plan. |
| `KNOWLEDGE_REPOSITORIES`, `KNOWLEDGE_REPO_PATH` | api | — | legacy | Single-repository fallbacks, used only when sources/destinations are unset. |
| `KNOWLEDGE_SOURCE`, `SOURCE_DATA`, `SOURCE` | api | — | legacy | Aliases for `KNOWLEDGE_SOURCES`, tried in that order after it. |
| `KNOWLEDGE_DESTINATION`, `DESTINATION` | api | — | legacy | Aliases for `KNOWLEDGE_DESTINATIONS`, tried in that order after it. |
| `KNOWLEDGE_FLOW` | api | — | legacy | Alias for `KNOWLEDGE_FLOWS`. |
| _any name given as a repository's `tokenEnv`_ | api **and** watcher | — | common | A source/destination may name an env var holding its own PAT (e.g. `OPS_DOCS_PAT`). Only the name travels in job payloads; each process reads the secret from its own environment. |

## AI providers (chat)

See [chat-providers.md](./chat-providers.md) and [ai-jobs.md](./ai-jobs.md). The API never
calls a chat model; these credentials belong to the **watcher**. A watcher advertises a
provider's capability only when that provider's required variables are all set.

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `AI_PROVIDER` | api | — | **essential** | `openai-compatible` \| `azure-openai` \| `codex` \| `claude`. The API refuses to start without it. |
| `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` | watcher (api for the embedding fallback and config display) | — | **essential** for `openai-compatible` | All three gate the capability. |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_CHAT_DEPLOYMENT` | watcher (api for embeddings and config display) | — | **essential** for `azure-openai` | All three gate the capability. |
| `AZURE_OPENAI_API_VERSION` | api, watcher | `2024-10-21` | tuning | Same default in both processes and in `packages/retrieval`. |
| `CODEX_CLI_PATH` | watcher | `codex` | **essential** for `codex` | Must be set (non-blank) for the capability to be advertised, even though the command itself defaults to `codex`. |
| `CLAUDE_CLI_PATH` | watcher | `claude` | **essential** for `claude` | Same rule as `CODEX_CLI_PATH`. |
| `CODEX_CLI_ARGS` | watcher | `exec` | tuning | Base arguments. Isolation flags are appended in code and cannot be configured away. |
| `CLAUDE_CLI_ARGS` | watcher | `-p` | tuning | As above. |
| `CODEX_CLI_PROMPT_MODE`, `CLAUDE_CLI_PROMPT_MODE` | watcher | `arg` | common on Windows | `arg` \| `stdin`. Anything other than `stdin` means `arg`. Use `stdin` on Windows. |
| `CODEX_CLI_MODEL`, `CLAUDE_CLI_MODEL` | watcher | CLI's own default | common | Appended as `--model <value>` when set. |
| `CHAT_TEMPERATURE` | watcher | `0.2` is sent | common | A number overrides it; `default` omits the field — required for reasoning deployments that reject an explicit temperature. |
| `AGENT_API_TIMEOUT_MS` | watcher (api reads it for config display only) | `120000` | tuning | Per-request timeout for hosted chat calls. |
| `AGENT_CLI_TIMEOUT_MS` | watcher | `120000` | tuning | Per-invocation timeout for one-shot CLI runs. |
| `MAGPIE_AGENTIC_TIMEOUT_MS` | watcher | `600000` | tuning | Timeout for source-grounded agentic runs. Keep below the 900 s queue expiry of the draft jobs. |
| `CLI_CANCEL_GRACE_MS` | watcher | `5000` | tuning | Grace period before a cancelled CLI run is killed. |
| `MAGPIE_CLI_ENV_PASSTHROUGH` | watcher | empty | common for Bedrock/Vertex | Extra variable **names** (comma/space separated) forwarded to spawned CLIs. |
| `AI_PRICING` | api | unset (no cost reporting) | common | JSON price table per (provider, model). A malformed value fails startup. |

### Variables forwarded to spawned agent CLIs

Spawned `codex`/`claude` processes receive a minimal allow-list instead of the watcher's
environment (`apps/watcher/src/runners/cli.ts`). The watcher does not interpret these; it
only passes them through when they are set. Class **internal** unless you use the CLI in
question.

- **Operational (both CLIs):** `PATH`, `HOME`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`,
  `LC_MESSAGES`, `TZ`, `TMPDIR`, `TMP`, `TEMP`, `TERM`, `USER`, `LOGNAME`, the Windows
  essentials (`SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `PATHEXT`, `HOMEDRIVE`,
  `HOMEPATH`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`,
  `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`), and proxy/CA settings (`HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`).
- **claude only:** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HEADERS`, `ANTHROPIC_CUSTOM_HEADERS`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CONFIG_DIR`.
- **codex only:** `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`,
  `OPENAI_ORG_ID`, `CODEX_HOME`.

Anything else (cloud credentials for Bedrock/Vertex, a nonstandard key) must be listed in
`MAGPIE_CLI_ENV_PASSTHROUGH`.

## Embeddings and retrieval

See [retrieval.md](./retrieval.md) and [ingestion.md](./ingestion.md). The API computes
embeddings inline, so these belong to the **API**. The embedding provider is auto-detected
from which variables are set; with none, retrieval is keyword-only.

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `OPENAI_COMPATIBLE_EMBEDDING_MODEL` | api, `scripts/eval-gap-threshold.ts` | — | **essential** for hybrid retrieval | Setting it (with a base URL) is what enables OpenAI-compatible embeddings. |
| `OPENAI_COMPATIBLE_EMBEDDING_BASE_URL` | api, eval script | falls back to `OPENAI_COMPATIBLE_BASE_URL` | common | Only needed when embeddings live on a different endpoint from chat. |
| `OPENAI_COMPATIBLE_EMBEDDING_API_KEY` | api, eval script | falls back to `OPENAI_COMPATIBLE_API_KEY` | common | Optional — unauthenticated local servers are supported (the API warns at startup). |
| `OPENAI_COMPATIBLE_EMBEDDING_DIMENSIONS` | api | not sent | tuning | Sent as `dimensions` only when set. Many servers reject the field. |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | api | — | **essential** for Azure embeddings | Enables Azure embeddings. |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS` | api | not sent | **essential** for `text-embedding-3-large` on Azure | Must be `1536` for that model; leave blank for ada-002. |
| `EMBEDDING_TIMEOUT_MS` | api | `60000` | tuning | Per-request timeout for embedding calls. |
| `FLOW_ROUTER_MIN_SCORE` | api | `0.25` | tuning | Float in [0,1]. Bad values fall back. |
| `FLOW_ROUTER_MIN_MARGIN` | api | `0.05` | tuning | Float in [0,1]. Bad values fall back. |
| `GAP_CLUSTER_ASSIGN_THRESHOLD` | api | `0.84` | tuning | Float in (0,1]. Re-tune with `npm run eval:gap-threshold` after changing the embedding model. Bad values fall back. |

## Job queue, rate limiting and AI capacity

See [ai-jobs.md](./ai-jobs.md) and [rate-limiting.md](./rate-limiting.md). All read by the API.

| Variable | Default | Class | Notes |
| --- | --- | --- | --- |
| `JOB_WAIT_TIMEOUT_MS` | `25000` | tuning | How long one `/api/jobs/:id/wait` call blocks. |
| `JOB_WAIT_POLL_MS` | `250` | tuning | Server-side poll cadence during a wait. |
| `JOB_SCHEDULE_TIMEZONE` | `UTC` | common | Timezone for cron schedules. |
| `MAGPIE_JOB_REPAIR_ENABLED` | on | tuning | Exactly `false` disables the one informed repair-reprompt for schema-invalid outputs. |
| `MAGPIE_JOB_OUTPUT_STRICT` | off | dev-test | `true` makes an undeclared job-output field a hard failure (API and watcher). Set by tests and the e2e/eval harnesses; leave unset in production, where such fields are stripped and logged. |
| `RATE_LIMIT_ENABLED` | on | common | Exactly `false` disables both the per-principal limiter and the AI capacity guard. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | tuning | Fixed-window width. |
| `RATE_LIMIT_ASK_PER_WINDOW` | `30` | common | `/ask` + `/retrieve` per principal per window. |
| `RATE_LIMIT_TRIGGER_PER_WINDOW` | `5` | tuning | Manual run/index triggers per principal per window. |
| `RATE_LIMIT_TRUST_FORWARDED_FOR` | off | common behind a proxy | Exactly `true` keys principal-less requests on `X-Forwarded-For`. Only behind a trusted reverse proxy. |
| `AI_MAX_INFLIGHT_JOBS` | `20` | common | Global ceiling on in-flight AI jobs — the main cost control. |
| `AI_INTERACTIVE_RESERVED_JOBS` | `5` | tuning | Slots reserved for interactive jobs. `0` disables the reserve. |
| `MAINTENANCE_MAX_AI_JOBS_PER_TICK` | `12` | tuning | Per-tick fan-out budget; keep ≤ ceiling − reserve. |
| `MAINTENANCE_FANOUT_ALERT_DEFERRED` | `20` | tuning | Deferred-enqueue count at which a tick's log event is flagged runaway. |

## Questionnaires

See [questionnaires.md](./questionnaires.md). All read by the API; bad values fall back.

| Variable | Default | Class | Notes |
| --- | --- | --- | --- |
| `QUESTIONNAIRE_MATCH_THRESHOLD` | `0.84` | tuning | Cosine floor for "same question re-asked". Float in (0,1]. |
| `QUESTIONNAIRE_MAX_INFLIGHT` | `3` | tuning | Items one questionnaire keeps in the answer pipeline. |
| `QUESTIONNAIRE_RECONCILE_CANDIDATES` | `3` | tuning | Top-N approved matches fed to reconcile. |
| `QUESTIONNAIRE_RECONCILE_ENABLED` | on | tuning | **Only the literal `0` disables it** — `false` does not. See [Inconsistencies](#known-inconsistencies). |

## Watcher process

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `WATCHER_NAME` | watcher (api reads it for config display only) | `local-dev-watcher` | common | Label shown on the Jobs screen. Replicas may share it; each gets a unique instance id. |
| `WATCHER_POLL_INTERVAL_MS` | watcher (api: display only) | `2000` | tuning | Claim-poll cadence. |
| `WATCHER_MAINTENANCE_TIMEOUT_MS` | watcher | `900000` | tuning | Abort deadline for the long maintenance orchestration callbacks. |
| `WATCHER_HEALTH_PORT` | watcher | `4002` | common | Health server port. An invalid port fails startup. |
| `WATCHER_HEALTH_HOST` | watcher | `0.0.0.0` | tuning | Health server bind address. |
| `WATCHER_HEALTH_STALE_AFTER_MS` | watcher | `120000` | tuning | `/health` returns 503 if the poll loop has not ticked within this window. |
| `WATCHER_ACTIVE_WINDOW_MS` | api | `900000` | tuning | How long a silent watcher is still listed as connected. |

## Git and publishing

See [proposals-and-publishing.md](./proposals-and-publishing.md). Git runs in both the API
(source/destination sync) and the watcher (publishing), so these apply to both.

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `GITHUB_TOKEN` | api, watcher | `gh auth token` if available | **essential** for GitHub flows | Clone/fetch/push and PR calls for github.com. Gates the watcher's `github` capability together with the author identity. |
| `MAGPIE_GH_CLI_AUTH` | api, watcher | on | tuning | Exactly `false` stops the fallback to the GitHub CLI's login when `GITHUB_TOKEN` is unset. |
| `MAGPIE_GIT_AUTHOR_NAME`, `MAGPIE_GIT_AUTHOR_EMAIL` | any process that commits (`packages/git`); the watcher's capability gates | — | **essential** for publishing | Commit identity. Publishing fails fast without both; they gate the `github` and `local-git` capabilities. |
| `AZURE_DEVOPS_PAT` | api, watcher | — | **essential** for Azure DevOps remotes | Clone/fetch/push for dev.azure.com / visualstudio.com. |
| `GIT_PROVIDER` | api | `local` | tuning | Display-only label on the config page. |
| `GIT_TIMEOUT_MS` | api, watcher | `120000` | tuning | Per git subprocess. Read once at module load. Bad values fall back. |
| `GIT_MAX_BUFFER_BYTES` | api, watcher | `67108864` | tuning | Git stdout/stderr buffer. |
| `GITHUB_API_TIMEOUT_MS` | api, watcher | `30000` | tuning | Per GitHub REST/GraphQL call. |
| `GIT_PARTIAL_CLONE` | api, watcher | `true` | tuning | `0`/`false`/`off`/`no` disables blobless partial clones. Read per call. A remote that rejects `--filter` already falls back automatically. |

`GIT_ALLOW_PROTOCOL`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` are
**set by the code** on every git subprocess (protocol allow-list and the auth header) and
deliberately override anything in the environment. They are not operator configuration.

## MCP server

See [mcp.md](./mcp.md).

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `MCP_RESOURCE_URL` | mcp (HTTP), web (fallback for the Connect panel) | `http://localhost:<port>/mcp` | **essential** for a deployed HTTP MCP | Public `/mcp` URL, used in the OAuth protected-resource metadata. |
| `MCP_AUDIENCE` | mcp (HTTP) | `MCP_RESOURCE_URL` | tuning | Only when the Auth0 API identifier differs from the public URL. |
| `MCP_HTTP_PORT` | mcp (HTTP) | `4001` | common | Listen port. |
| `MCP_HTTP_HOST` | mcp (HTTP) | `127.0.0.1` | common | Bind address. Compose sets `0.0.0.0`. |
| `NEXT_PUBLIC_MCP_URL` | web | falls back to `MCP_RESOURCE_URL` | tuning | Endpoint shown in the console's Connect panel. |
| `ANSWER_POLL_INTERVAL_MS` | mcp | `1000` | tuning | Poll cadence while awaiting an answer. |
| `ANSWER_TIMEOUT_MS` | mcp | `120000` | tuning | Give up waiting for an answer. |
| `OUTLINE_POLL_INTERVAL_MS` | mcp | `1500` | tuning | Poll cadence while awaiting a seed outline. |
| `OUTLINE_TIMEOUT_MS` | mcp | `180000` | tuning | Give up waiting for a seed outline. |

`MAGPIE_MCP_URL` is not read by any Magpie process: it is expanded by Claude Code in the
plugin's `.mcp.json` (`plugin/markdown-magpie/`) to point the plugin at a deployment.

## Observability

See [observability.md](./observability.md). Telemetry is off unless an OTLP endpoint is set.

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | api, watcher | unset (telemetry off) | common | Setting it turns tracing and metrics on. |
| `OTEL_SERVICE_NAME` | api, watcher | `api` / `watcher` | tuning | Service name override. |
| `MAGPIE_TELEMETRY_ENABLED` | api, watcher | on when an endpoint is set | tuning | Exactly `false` force-disables telemetry. |
| other `OTEL_*` (e.g. `OTEL_EXPORTER_OTLP_HEADERS`) | OpenTelemetry SDK | SDK defaults | tuning | Read by the SDK directly, not by Magpie code. |

## Web console (build and dev)

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `MAGPIE_DEV_API_PROXY` | web (`next.config.mjs`) | unset | dev/test | Proxies same-origin `/api/*` to a local API in `next dev`. Inert in Docker/production. |
| `NEXT_DIST_DIR` | web (`next.config.mjs`) | `.next-build` in production, else `.next-dev` | dev/test | Next.js output directory. |

## Build metadata (set by the image build)

| Variable | Read by | Default | Class | Notes |
| --- | --- | --- | --- | --- |
| `MAGPIE_BUILD_SHA`, `MAGPIE_BUILD_COMMIT_MESSAGE`, `MAGPIE_BUILD_COMMITTED_AT` | api | unset ("Development" build) | internal | Baked into the image by the `Dockerfile` from the `GIT_SHA`, `GIT_COMMIT_MESSAGE` and `GIT_COMMITTED_AT` build args; shown as the console's build status. |
| `INIT_CWD` | api | working directory | internal | Set by npm. Relative `MAGPIE_*` paths resolve against it when present, so `npm run dev:api` resolves from the repo root. |

## Scripts, tests and local tooling

None of these affect a running deployment. Class **dev/test**.

| Variable | Read by | Default | Notes |
| --- | --- | --- | --- |
| `RUN_PG_INTEGRATION` | Postgres-backed `*.integration.test.ts` | unset (skipped) | `1` enables them; `npm run test:db` provides the database. |
| `TEST_POSTGRES_IMAGE` | `scripts/test-db.mjs` | `pgvector/pgvector:pg16` | Image for the throwaway test database. |
| `E2E_API_BASE_URL` | `scripts/e2e-jobs.ts` | `http://localhost:4000` | API under test. |
| `E2E_API_TOKEN` | `scripts/e2e-jobs.ts` | — | Bearer token when the API under test has auth on. |
| `EVAL_TIMEOUT_MS` | `scripts/eval-api.ts` | `30000` | Request timeout. |
| `EVAL_CASES_JSON` | `scripts/eval-api.ts` | built-in cases | JSON array overriding the eval cases. |
| `FIXTURE_PORT` | `scripts/fixtures/openai-fixture.mjs`, `golden-provider.mjs` | `8800` / `8801` | Deterministic provider fixture port. |
| `FIXTURE_SLOW_DELAY_MS` | `scripts/fixtures/openai-fixture.mjs` | `20000` | Delay for the fixture's slow model. |
| `CHROME_PATH`, `CHROME_FLAGS` | `scripts/render-static-ui-shots.mjs` | a Windows Chrome path / none | Screenshot tooling. |

`scripts/eval-golden.ts` builds the environment of the API and watcher it spawns itself
(`AI_PROVIDER`, `STORAGE_BACKEND`, `RATE_LIMIT_ENABLED`, the knowledge variables, …); those
are the same variables documented above, set by the script rather than read from you.

## Docker Compose and CI

These are not read by application code but are part of the configuration surface.

| Variable | Where | Notes |
| --- | --- | --- |
| `MAGPIE_EMBEDDING_MODEL` | `docker-compose.yml` (`embeddings` profile) | Model the bundled Ollama sidecar pulls; default `nomic-embed-text`. |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `docker-compose.yml` (`postgres`) | The bundled test-grade Postgres. Use a managed database in production. |
| `GF_AUTH_*` | `docker-compose.yml` (`grafana`) | Anonymous viewer access for the optional logging stack. |
| `NEXT_TELEMETRY_DISABLED` | `Dockerfile` | Disables Next.js telemetry in the image. |
| `GIT_SHA`, `GIT_COMMIT_MESSAGE`, `GIT_COMMITTED_AT` | `Dockerfile` build args | Become the `MAGPIE_BUILD_*` variables above. |
| `CONTAINER_IMAGE_REGISTRY`, `CONTAINER_IMAGE_NAME`, `CONTAINER_IMAGE_PLATFORMS`, `CONTAINER_REGISTRY_USERNAME`, `CONTAINER_REGISTRY_TOKEN` | `.github/workflows/publish-image.yml` (repository variables/secrets) | Where and how the image is published. |

Compose passes `.env.compose.example` and then `.env.compose` to every service as an
`env_file`, and then sets a few values per service under `environment:`, which **wins over
the env files**:

- Pinned literals: `PORT`, `MAGPIE_CHECKOUT_ROOT=/data/checkouts`,
  `MAGPIE_SNAPSHOT_ROOT=/data/snapshots`, `MCP_HTTP_PORT`, `MCP_HTTP_HOST`. Setting these in
  `.env.compose` has no effect.
- Interpolated from the **shell or the project-directory `.env`** (Compose's own
  interpolation, not the `env_file`): `AI_PROVIDER` for the API and watcher, and for the
  watcher `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`,
  `OPENAI_COMPATIBLE_MODEL`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`,
  `AZURE_OPENAI_CHAT_DEPLOYMENT`, `CODEX_CLI_PATH` (default `codex`) and `CLAUDE_CLI_PATH`.
  A value for one of these that exists only in `.env.compose` is replaced by the
  interpolated one (an empty string when the shell and `.env` do not define it), so keep
  them in the project `.env` or pass `--env-file`.

`docker-compose.watcher.yml` (a standalone remote watcher) instead loads `.env` as its
`env_file` and pins only `MAGPIE_CHECKOUT_ROOT`.

## Names that are not read

Earlier versions read these; nothing does now. A leftover in an old `.env` is harmless and
can be deleted.

| Variable | Status |
| --- | --- |
| `AI_EXECUTION_MODE` | Removed with the queue-only migration. There is no "direct mode". |
| `QUEUE_URL` | Never read. The queue is pg-boss in Postgres (`DATABASE_URL`); Redis is not used. |
| `EMBEDDING_PROVIDER` | Never read. The embedding provider is auto-detected from the embedding variables. |

## Known inconsistencies

Recorded so they are not rediscovered; none is a bug, and none has been changed because
changing them could alter the behaviour of an existing deployment.

- **Boolean spellings differ.** Most opt-outs only honour the literal `false`
  (`AUTH_REQUIRED`, `RATE_LIMIT_ENABLED`, `MAGPIE_JOB_REPAIR_ENABLED`, `LOG_STARTUP_CONFIG`,
  `MAGPIE_TELEMETRY_ENABLED`, `MAGPIE_GH_CLI_AUTH`); `RATE_LIMIT_TRUST_FORWARDED_FOR` only
  honours `true`; `GIT_PARTIAL_CLONE` accepts `0/1`, `true/false`, `on/off`, `yes/no`; and
  `QUESTIONNAIRE_RECONCILE_ENABLED` only honours `0`, so `QUESTIONNAIRE_RECONCILE_ENABLED=false`
  leaves it **on**.
- **Strict vs. lenient parsing.** Integer knobs in the API/watcher loaders fail startup on
  a non-numeric value. The float thresholds, the questionnaire knobs, the `GIT_*` limits,
  `SOURCE_SYNC_MAX_CHANGED_FILES`, the MCP poll/timeout knobs and the watcher's provider
  timeouts silently fall back to the default instead.
- **Same variable, several readers.** `MAGPIE_CHECKOUT_ROOT` is defaulted in four places
  (the API loader and three watcher runners) and `AZURE_OPENAI_API_VERSION` in four; the
  defaults are identical today (`.magpie/checkouts`, `2024-10-21`) but nothing enforces it.
  `LOG_LEVEL`/`NODE_ENV` are read independently by each app's `logger.ts`, again with the
  same default.
- **Read for display only.** The API reads `WATCHER_NAME`, `WATCHER_POLL_INTERVAL_MS`,
  `AGENT_API_TIMEOUT_MS` and `GIT_PROVIDER` only to echo them on the config page. With no
  value in the API's environment the page shows nothing for them even though the watcher is
  running on its own default — it does not show the watcher's effective value.
- **`CODEX_CLI_PATH` / `CLAUDE_CLI_PATH` have a default command but no default
  capability.** The runner would spawn `codex`/`claude` by default, but the capability is
  only advertised when the variable is explicitly set.
