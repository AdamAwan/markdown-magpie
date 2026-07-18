---
name: magpie-orientation
description: Architecture and conventions orientation for the Markdown Magpie repo. Use at the start of any development session on this repo to ramp up fast — explains the queue-only AI model, the end-to-end feature pipeline, the job catalog, where code lives (apps/ and packages/), and the project conventions and gotchas. Pairs with run-magpie (for actually launching the stack).
---

# Orienting in Markdown Magpie

Markdown Magpie is a Git-backed Markdown knowledge maintenance system: it indexes docs,
answers questions with citations, logs weak answers, clusters them into knowledge gaps,
drafts source-grounded Markdown improvements with per-claim provenance, publishes them as
pull requests (or local-git branches) for human review, verifies after merge that the gap
actually closed, and continuously patrols the knowledge base for rot.

It is an **npm-workspace monorepo** (Node ≥22.13, ESM/NodeNext, TypeScript). Read this
before designing changes — the AI-execution model is easy to get wrong from intuition.

## 1. The queue-only mental model (read this first)

**The API never calls a chat/generative model inline.** This is the single most important
fact and the one most likely to be designed against by accident. (Embeddings are the one
exception — see the note at the end of this section.)

```text
client → POST /api/ask
  → API records the question + enqueues an `answer_question` job (pg-boss, in Postgres)
  → API responds 202 with a job id (no answer yet)
  → watcher claims the job, routes to a flow, calls BACK into the API over HTTP
      for scoped context (e.g. retrieval), invokes the configured provider,
      then POSTs the result back to the API
  → answer is now stored; client reads it via /api/jobs/<id>/wait + /api/questions/<id>
```

Implications you must design around:

- **All generative/chat work is a job + a watcher flow + an API callback.** Never add a
  code path where the API process calls a *chat/generative* provider directly. If you need
  generative AI work done, model it as a job (see the **add-a-job-type** skill). The API's
  own comment in `apps/api/src/platform/providers.ts` says it: the API never runs AI
  inline and does not hold chat-provider credentials — watchers do.
- **The watcher is required** for any AI work. Without a running watcher, `POST /api/ask`
  returns a 202 job that never completes. There is **no "direct mode"** — the old
  `AI_EXECUTION_MODE` was removed in the queue-only migration.
- **A watcher runs one job at a time** (`apps/watcher/src/worker-loop.ts`): claim one job,
  heartbeat, report exactly one terminal outcome.
- **Maintenance orchestrators need ≥2 watchers.** A maintenance job (`verify_gap_closure`,
  the patrols, the reconciler) claims a watcher, then *blocks* in an API callback while the
  API bounded-waits on the follow-up AI jobs it enqueues. Since a watcher runs one job at a
  time, those follow-ups can only be answered by a **second** watcher — with one watcher
  the orchestration self-starves and times out. `verify_gap_closure` handles that timeout
  safely (an incomplete re-ask is an infra failure that retries, never a false `still_open`
  — #150), and the console warns when only one watcher is connected. Run two locally (see
  the **run-magpie** skill).
- **The watcher has no database access** — its package.json has no `@magpie/db`, `pg`, or
  `pg-boss` dependency. API and watcher share only (a) the HTTP API
  (`apps/watcher/src/http-client.ts` is the sole conduit: claim/heartbeat/complete/fail
  plus callbacks like `/api/retrieve`, `/api/route`, `/api/gaps/reconcile`,
  `/api/source-map`) and (b) the shared checkout volume (`MAGPIE_CHECKOUT_ROOT`, default
  `.magpie/checkouts`), which hosts destination checkouts and read-only *source*
  workspaces for source-grounded jobs.
- **Six job types are agentic and source-grounded**: `draft_seed_document`,
  `draft_markdown_proposal`, `outline_flow_seed`, `verify_document`, `correct_document`,
  `improve_document`
  (authoritative switch: `sourceGroundedInputSchema()` in
  `apps/watcher/src/source-workspace.ts`). They carry `SourceDescriptor[]` references
  (kinds `git`/`local` resolve to filesystem workspaces; `agent` becomes a prompt note;
  `internet` is a prompt note too UNLESS the operator opted it into fetching with a
  non-empty `allowedHosts` allowlist — #242, `apps/watcher/src/fetch-url.ts`: the tool
  loop then gets a bounded https-only `fetch_url` tool and claude CLI runs get a
  domain-scoped WebFetch; codex stays note-only, its sandbox blocks network), not
  sampled file content. The agent explores the checkout directly:
  - **CLI providers** (codex, claude) traverse natively; read-only is enforced in code
    (`readOnlyArgs()` in `runners/cli.ts` — e.g. `--tools Read,Grep,Glob` for claude,
    `--sandbox read-only` for codex) so operator arg config can't drop it. CLI runs are
    also environment-isolated in code (`generativeIsolationArgs()` for one-shot runs:
    neutral temp-dir cwd, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`,
    system prompt via `--system-prompt`; source-grounded claude runs get the MCP/settings
    flags too) so host or checkout MCP config, settings/hooks, and CLAUDE.md never reach
    the agent — see "CLI environment isolation" in `docs/ai-jobs.md`.
  - **HTTP providers** run a bounded tool loop (`runners/source-agent.ts`): `list_dir` /
    `read_file` / `grep` tools, max 24 steps, 400 KB total read budget, realpath
    confinement (no `..`/symlink/absolute escape). Infra faults fail the job — the loop
    never forces an ungrounded answer.
  - The watcher stamps `mapUpdates.observedSha` from the checkout HEAD itself — an infra
    fact never trusted from the model.
- **Provider-neutral.** `AI_PROVIDER` selects `openai-compatible | azure-openai | codex |
  claude`. A watcher advertises a **capability** only when its readiness gate passes
  (`apps/watcher/src/capabilities.ts` — env presence per provider; `github` requires
  `GITHUB_TOKEN` + git author config and also satisfies `local-git`; `maintenance` is
  always ready), and the API only routes a job to a capability a running watcher offers.
  `runners/index.ts` consults the same gates, so advertisement ⇔ runner exists.
- **Job type vs. queue name.** The job *type* string names the Schedules UI row, the
  `/dataflow` box, and the `type=` filter. The pg-boss *queue name* equals the type for
  non-provider jobs, but **provider (AI) jobs fan out per provider** —
  `` `${type}__${provider}` `` (e.g. `answer_question__openai_compatible`) — and
  `publish_proposal` fans out per **destination** (`publish_proposal__github` /
  `publish_proposal__local_git`). See `packages/jobs/src/catalog.ts`; every queue also
  gets a `__dead_letter` twin.

**Embeddings are the exception to "queue-only".** The API computes embeddings **inline**
(it holds an embedding provider, 1536-dim) for indexing
(`apps/api/src/stores/embed-sections.ts`), query-time retrieval
(`apps/api/src/stores/knowledge-index.ts`, with an LRU query cache), flow routing, and
gap-cluster bucketing. So "the API never calls a provider inline" is true for
*chat/generative* work only.

## 2. The product pipeline (feature map)

The end-to-end lifecycle, with pointers. Docs in `docs/` are the distilled reference
(`architecture.md`, `ai-jobs.md`, `question-logging.md`, `ingestion.md`, `api.md`);
known-stale passages are flagged inline there (e.g. the superseded shared-source-corpus
design in `maintenance-redesign.md`). When in doubt, trust the code.

1. **Ingest & index** — `KNOWLEDGE_SOURCES` (read-from) / `KNOWLEDGE_DESTINATIONS`
   (curated KB, written-to) / `KNOWLEDGE_FLOWS` (source→destination links). **Only the
   destination KB is indexed as the answer corpus**; raw sources only ground drafting.
   Deterministic section ids + embedding carry-forward on re-index: unchanged sections
   keep their vectors, so re-indexing an unchanged corpus costs zero embedding calls.
   Section vectors carry an `embedding_model` stamp (migration 0052): vector search only
   matches the configured model's vectors, and a model change re-embeds via the same
   carry-forward path (`docs/ingestion.md`).
2. **Retrieval** — hybrid pgvector + in-memory keyword scoring fused with Reciprocal Rank
   Fusion (`packages/retrieval/src/rrf.ts`); keyword-only fallback without embeddings.
   Mode reported at `GET /api/config` → `retrieval.mode`.
3. **Flow routing** — embedding-similarity router first
   (`packages/retrieval/src/flow-router.ts`, abstain-biased: needs `FLOW_ROUTER_MIN_SCORE`
   *and* a `FLOW_ROUTER_MIN_MARGIN` over the runner-up), falling back to the LLM chat
   router (`routing.ts`, degrades to `unroutable`, never fails the ask). Off-topic
   questions come back `outOfScope`.
4. **Ask/answer** — enqueue-only `POST /api/ask`. The watcher runs an agentic retrieval
   loop (bounded model-driven follow-up searches), synthesizes with citations of **used
   sections only**, then a second grounding-verification model call (`verify-answer`
   prompt) strips unsupported claims before the answer is stored.
5. **Question logging & gap detection** — every question logs text, confidence, flow,
   citations, answer trace, and feedback. Gap sources: `auto` (whole-question miss),
   `followup` (confident answer, empty follow-up search), `manual` (flagged), and
   `verification` (merged proposal failed to close). Verification re-asks are tagged
   `purpose: "verification"` so they never become gap candidates (`docs/question-logging.md`).
6. **Gap clustering** — two phases. Phase 1 is **embedding bucketing** (#216): each gap
   summary is embedded and assigned, within its flow, to the nearest cluster whose stored
   centroid clears `GAP_CLUSTER_ASSIGN_THRESHOLD` (default 0.84 — deliberately
   conservative, near-identical rewordings only); leftovers form connected components.
   Pure order-independent planner in `apps/api/src/scheduling/gap-assignment.ts`;
   representatives persisted per cluster (migration 0046). Phase 2 is the **reshape
   critic** — a `reconcile_gap_clusters` AI job proposing merge/split/dismiss, each
   critic-confirmed, short-circuited by a composition hash when nothing changed.
7. **Drafting** — `draft_markdown_proposal` (source-grounded, see §1). File location is
   system-owned (`<destination subpath>/<title-slug>.md`). Conflicting stale PRs get keyed
   auto-regeneration (`regenerateProposalId`; approved PRs are never rewritten, per-proposal
   regen cap). Reopened gaps feed their verification notes back in as `resubmissionNotes`.
8. **Factual document register** (#213) — every content-producing prompt carries
   `FACTUAL_REGISTER_CONTRACT` (`packages/prompts/src/catalog.ts`): documents state what
   sources state; no model-authored recommendations/next-steps/roadmaps. Points the
   sources don't cover are **omitted from the body** and returned as `uncoveredPoints`,
   folded into the proposal rationale. Backstop: `findAdvisoryHeadings`
   (`packages/markdown/src/advisory.ts`) flags advisory headings in outputs — flags,
   never fails (`apps/api/src/features/proposals/register-check.ts`).
9. **Claim provenance** (#214) — drafts/rewrites emit a structured
   `provenance: ProvenanceClaim[]` (claim + section `anchor` + source locations); the
   document **body carries no repository paths or source names** (the old inline "(see …)"
   citations leaked into answers — fixed by construction, and the verify prompt flags any
   legacy inline citation as a defect). Provenance is persisted on
   `proposals.provenance` (migration 0049) and rendered in the PR body and the console
   proposal view. It is an **append-only event log, not a living map**: at patrol time the
   API folds a document's merged-proposal event stream
   (`listMergedByTargetPath`, migration 0050;
   `foldProvenanceEvents` in `apps/api/src/features/proposals/provenance.ts` — claims
   whose anchor no longer exists are dropped, forcing re-derivation) into advisory
   `citedClaims` for `verify_document`. `correct_document`, `improve_document`
   (improved:true branch), and `fold_markdown_proposal` all emit provenance for their own
   diffs; a missing provenance is warned about, never blocking.
10. **Proposals, review & publication** — lifecycle `draft → ready → branch-pushed →
    pr-opened → merged / rejected / superseded`. Publish is a job: the watcher fetches a
    credential-free `GET /api/proposals/:id/execution-context`, commits to a
    `magpie/proposal-*` branch, pushes, and (GitHub) opens a PR. **Merging is always a
    human action** — the primary prompt-injection control. Byte-identical publishes
    settle as `superseded`. **Local-git flows** (`file://` destinations) replace the PR
    with console **Accept** (git-merge + resolve gaps + re-index) / **Bin** (reject +
    freeze cluster); GitHub-only tasks (PR polling, crosslinking) never run for them.
    The API holds no GitHub token — PR state re-enters only via the github watcher's
    `refresh_flow_snapshot` completions.
11. **Maintenance patrols** — the old whole-KB "Crunch" is retired; rolling-cursor patrols
    work one doc (+ neighbours) at a time. **Correctness patrol** (hourly) fans into
    `verify_document` → `correct_document` / `dedupe_documents` / `split_document`;
    **editorial patrol** (hourly) fans into `improve_document`. A change gate skips docs
    whose content-hash + source-descriptor-hash are unchanged. All doc producers pass a
    shared **reconcile gate** (open-new / fold-into-overlapping-proposal / defer) before
    publishing (`apps/api/src/scheduling/fold.ts`).
12. **Gap-closure verification on merge** (#150/#154) — a merge never blindly resolves
    gaps. The merge cascade enqueues `verify_gap_closure`, which re-asks each triggering
    question and applies a deterministic test: closed only if the re-ask is confident
    *and cites a merged target doc*. Outcomes on `proposals.closure_status`:
    `verified_closed` (the only path that resolves gaps), `reopened` (re-draft with
    notes), `needs_attention` (after 2 failures the question is **parked** — a state, not
    a gap source; humans Retry/Dismiss from the console).
13. **Seeding** — plan-centric and self-seeding: `POST /api/flows/:id/outline` (no topic;
    optional `notes` steer) enqueues the **source-grounded** `outline_flow_seed` job, whose
    agent explores the flow's sources and proposes a whole-flow document plan — plus a
    `proposedCharter`/`proposedPersona` when the flow config lacks them (the system never
    writes flow config; the console offers copy-to-config). The completion handler persists
    the plan in `seed_plans` (proposed → approved | dismissed | superseded; a new proposed
    plan supersedes an older un-reviewed one). Humans review at `/seed` or
    `/api/seed-plans/*` (PATCH edits only while proposed; approve is replay-safe and the
    **only** drafting entry point — the raw `POST /flows/:id/seed` is gone): approval
    enqueues one `draft_seed_document` per approved item carrying the plan's run-scoped
    `charter`/`persona` + `seedPlanId` (proposal linkage), straight to proposal → PR via the
    reconcile gate. A proposed plan can also be **revised in place** by a natural-language
    instruction (`POST /api/seed-plans/:id/revise { instruction }` → the **non**-source-grounded
    `revise_seed_plan` job): its completion handler reshapes the same plan's items (and
    charter/persona when the instruction implies it) without re-exploring the sources, so
    "don't mention X" iterates on the plan rather than re-outlining from scratch. The hourly per-flow `seed_bootstrap` maintenance job auto-proposes a
    plan for a flow with sources but < `SEED_BOOTSTRAP_MAX_DOCS` (default 3) indexed docs —
    self-quiescing guards; a dismissed plan is not re-proposed until the flow's source
    descriptors change (source-hash comparison). A flow's optional `charter` config field
    (coverage mission) is planning-scope guidance only — distinct from `persona` (voice) and
    `routingSummary` (router blurb).
13a. **Questionnaires** — explicit bulk question batches (security questionnaires) with
    verbatim answer reuse (`docs/questionnaires.md`). A batch is pinned to a flow; items
    are embedding-matched against prior **approved** items (0.84 near-verbatim bar) and a
    matched answer is reused verbatim only if (a) every cited section is byte-unchanged
    (md5 fingerprints vs `document_sections.content_changed_at` tracking, migration 0054)
    AND (b) retrieval finds nothing relevant newer than the answer's generation time.
    Everything else drips through the questionnaire's own `answer_question_batch` job
    (#288c — same answer handler as `answer_question` but a distinct, non-interactive
    type so a bulk batch can't erode the live-ask reserve; `QUESTIONNAIRE_MAX_INFLIGHT`
    per batch is now a secondary bound, purpose `"questionnaire"` — in gap candidacy, out
    of the questions list). Approval admits answers to the future match corpus;
    `/questionnaires` console page reviews/exports.
14. **Source map** (#215/#219/#220) — agents' own navigation hints about source repos:
    `(sourceId, topic) → paths + description`, persisted in `source_map_entries`
    (migration 0047). Source-grounded job outputs contribute optional `mapUpdates`
    (capped 20/job, 200/source, best-effort — never fails a job); repeated independent
    agreement bumps a `consensusCount` (Jaccard > 0.5, cap 5). The watcher reads hints at
    workspace prep via `GET /api/source-map` and injects them as **unverified hints**.
    Strictly internal — must never enter retrieval or answers.
15. **Source-change sync** — `source_change_sync` (~10 min) diffs source checkouts and
    turns relevant changes into a `MaintenancePlan` (via
    `sync_source_changes_generate_plan`) → proposals through the shared gate.
16. **Insights** — 10 charts (question journey, gap backlog, job throughput, latency,
    verification success, job errors, freshness, patrol impact, answer feedback, AI
    token usage) over a fixed 30-day window; `apps/api/src/features/insights/` +
    `/insights` console page (`docs/insights-charts.md`). AI token usage (#241) is
    aggregated from the `usage` field the watcher reports on job completions — CLI
    providers report nothing, so their jobs chart as unmetered, not free.
17. **Rate limiting & AI capacity** — L1: per-principal fixed-window limiter with tiers
    `ask` (30/window) and `trigger` (5/window) → 429 + `Retry-After`
    (`apps/api/src/http/rate-limit.ts`; no-op when auth is off). L2: a global in-flight
    AI-job cap (`AI_MAX_INFLIGHT_JOBS`, default 20) enforced at enqueue time *before*
    recording the question log (`apps/api/src/platform/ai-capacity.ts`) —
    admission control, not backpressure (`docs/rate-limiting.md`). L2 is class-aware
    (#240): interactive jobs (`INTERACTIVE_AI_JOB_TYPES` — `answer_question`,
    `outline_flow_seed`) keep `AI_INTERACTIVE_RESERVED_JOBS` (default 5) in-flight
    slots that maintenance fan-out never occupies, and brokers probe interactive
    queues first on claim — so patrol bursts can't starve live asks.
18. **Authorization** — single-tenant, two layers: global scopes (`read:knowledge`,
    `ask:knowledge`, `manage:knowledge`, `manage:jobs`, `manage:admin`,
    `feedback:questions`) via `requireScopes`, plus **flow-scoped capabilities**
    (`read`/`manage`/`ask` per flow) mapped from IdP role names via
    `KNOWLEDGE_ROLE_GRANTS`. Fail-closed with deliberate permissive carve-outs (auth off,
    no grants configured, genuine M2M tokens — identified by the POSITIVE
    `gty: "client-credentials"` marker, not merely an absent roles claim, so a human
    token whose roles claim went missing fails CLOSED). Cross-flow ids read as 404,
    not 403 (`docs/authorization.md`).
19. **MCP** (`apps/mcp`) — thin client over the HTTP API, stdio + Streamable-HTTP
    transports, **ten tools**: `kb_ask`, `kb_search`, `kb_citation`, `kb_feedback`,
    `kb_flows`, `kb_outline`, `kb_seed`, `kb_questionnaire_create`,
    `kb_questionnaire_get`, `kb_questionnaire_approve` (questionnaire create is
    deliberately non-waiting — items drip through the answer queue; clients re-read the
    worksheet until it settles). HTTP transport is its own OAuth protected resource with
    per-tool scopes; downstream API calls use a separate M2M credential (never the user's
    token) plus on-behalf-of headers (`docs/mcp.md`).
20. **Observability** — `@magpie/telemetry` (OpenTelemetry traces + metrics, **off by
    default**; enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set) threads W3C trace
    context API → pg-boss job → watcher → callback; metrics `magpie.jobs.finished` /
    `magpie.jobs.duration`. Structured pino logging via `@magpie/logger` (pretty mode
    renders in-process, not via a worker thread — #236). `deploy/` has a
    Loki/Grafana/Alloy log stack.

## 3. Job catalog cheat sheet

27 job types in `packages/jobs/src/types.ts`; contracts in `schemas.ts`, routing in
`catalog.ts`. AI (provider-fanned) jobs get retry 3 / backoff 15→300 s; others retry 2
(maintenance-class AI — `AI_JOB_TYPES − INTERACTIVE_AI_JOB_TYPES` — also drops to retry 2).

**Retry vs. terminal-fail on invalid output (#288d).** That retry budget is for
*transient* failures. A **schema-invalid** completion is deterministic — it would
reproduce on every retry — so it does NOT spend the budget blindly. For a
**repairable** job type (the reshape-style provider jobs, flagged
`repairable` in the catalog / `isRepairableJobType`), the first invalid output
gets **one informed repair**: the prior output + Zod issues are stashed in the
`job_repair_contexts` store keyed by job id, the SAME job is re-dispatched
(`active→retry`, preserving every waiter + the question-log linkage), and the
watcher runs a single-shot reshape (`runRepairReprompt`, no retrieval/agent loop;
`answer_question` also enforces a citation-subset guard). Everything else — a
non-repairable (source-grounded/agentic/patch-emitting) type, repair disabled
(`MAGPIE_JOB_REPAIR_ENABLED=false`), or a repair run that is invalid *again* —
**terminal-fails immediately** (`JobBroker.failTerminal`: straight to `failed` +
dead-letter). Net: original + at most one repair, then terminal — no blind paid
retries. Each decision emits a `job_repair` event; a successful completion warns
on any undeclared fields the `z.object` output schema stripped.

**18 provider (AI) jobs** — queue `` `${type}__${provider}` ``:
`answer_question`, `answer_question_batch`, `summarize_gap`, `draft_markdown_proposal`,
`draft_seed_document`, `outline_flow_seed`, `revise_seed_plan`, `fold_markdown_proposal`,
`fold_changeset_proposal`, `detect_contradiction`, `suggest_consolidation`,
`reconcile_gap_clusters`, `sync_source_changes_generate_plan`, `verify_document`,
`correct_document`, `dedupe_documents`, `split_document`, `improve_document`.
`answer_question_batch` (#288c) is the questionnaire drip's own type: same answer handler
as `answer_question`, but metered-yet-**non-interactive** so a bulk batch can't 429 a
live ask via the interactive reserve.

**10 non-provider jobs**:

| type | capability | trigger | role |
|---|---|---|---|
| `process_gaps_to_pull_requests` | maintenance | cron ~10 min | orchestrator → `POST /api/gaps/reconcile` |
| `source_change_sync` | maintenance | cron ~10 min | orchestrator → `POST /api/source-sync/run` |
| `correctness_patrol` | maintenance | cron hourly | orchestrator → `POST /api/fix-patrol/run` |
| `editorial_patrol` | maintenance | cron hourly | orchestrator → `POST /api/fix-patrol/improve/run` |
| `verify_gap_closure` | maintenance | **on merge** (not cron) | orchestrator → `POST /api/proposals/:id/verify-closure` |
| `seed_bootstrap` | maintenance | cron hourly | guard-check → `POST /api/flows/:id/seed-bootstrap/run` (enqueue-and-return, never bounded-waits) |
| `refresh_flow_snapshot` | github | cron ~5 min (GitHub flows only) | leaf: polls PRs, reports mergeability |
| `publish_proposal` | github / local-git (destination fan-out) | event | leaf: push branch, open PR |
| `crosslink_pull_requests` | github | event | leaf: comment linking two PRs |
| `comment_pull_request` | github | event | leaf: one PR comment |

Maintenance jobs are *orchestrators*: they POST a thin API endpoint where the heavy
orchestration lives, and the API bounded-waits on the tier-2 AI jobs it enqueues
(`runJobToCompletion` — reuses in-flight jobs via `reuseKey`, and on timeout **cancels the
orphaned job** so a late watcher never runs a paid generation nobody reads). A Postgres
advisory lock keyed on (taskType, flowId) serialises overlapping runs
(`apps/api/src/scheduling/run-lock.ts`). Cron tasks are registered **per flow** from
`flowTaskTemplates` in `apps/api/src/scheduling/task-registry.ts` and managed from the
Schedules page.

## 4. Where code lives

```text
apps/
  api/       HTTP API + job-queue owner. Feature modules under src/features/ (ask, route,
             retrieve, questions, jobs, gaps, proposals, reconciliations, snapshots,
             maintenance-runs, seed, knowledge, config, prompts, workers, scheduled-tasks,
             insights, source-sync, source-map), each mounted at /api/<prefix> in
             src/app.ts. Orchestration in src/scheduling/ (gap-reconciler, gap-assignment,
             fold, run-lock, task-registry), stores in src/stores/, queue in src/jobs/
             (pg-boss-broker + schedule-reconciler), platform wiring in src/platform/.
  watcher/   Worker that claims jobs and calls the provider. Flat src/runners/ dir:
             chat.ts (HTTP providers), cli.ts (codex/claude), generative.ts (one-shot),
             source-agent.ts (bounded tool loop), maintenance.ts, publication.ts,
             refresh-flow-snapshot.ts. Capability gates in src/capabilities.ts; source
             workspaces in src/source-workspace.ts; API client in src/http-client.ts.
  web/       Next.js (App Router) review + admin console. 15 nav sections
             (src/lib/sections.ts): /ask, /knowledge, /gaps, /seed, /questionnaires, /proposals,
             /source-map, /jobs, /activity, /insights, /schedules, /config, /dataflow,
             /prompts, /mcp (+ unlisted /reconciliations, /snapshots). UI is Emotion
             CSS-in-JS with a typed design-token theme (src/theme/) and a primitive
             library (src/components/ui/: Button, IconButton, Badge, Chip, Surface,
             Field/Input/Textarea/Select, Stack, Row, ScrollList, ListRow, Actions,
             EmptyState, Workbench). There is NO global stylesheet — style with those
             primitives + colocated `styled` reading `p => p.theme.*`; never add a .css
             file (the only .css imports allowed are third-party React Flow styles).
  mcp/       MCP server — a client surface over the API (ten kb_* tools, see §2.19).
             Only needed for MCP clients; skip for a normal run.
packages/
  core/       Shared domain types + provider interfaces (incl. ProvenanceClaim).
  auth/       Auth0 token validation + on-behalf-of helpers.
  db/         SQL migrations (0001–0055; see the write-a-migration skill).
  git/        Git sync + PR adapters: ensureGitCheckout (blobless partial clones),
              PR status/mergeability polling, LocalGitProposalPublisher, checkout locks.
  jobs/       Job contracts: JOB_TYPES, capabilities, input/output schemas, queue
              policies (src/types.ts + src/schemas.ts + src/catalog.ts). Start here when
              adding or changing a job.
  logger/     Shared structured pino logging + crash handlers.
  markdown/   Markdown parsing, frontmatter, sectioning, advisory-heading detection.
  prompts/    Shared AI prompt catalog (21 prompts, shared contract constants:
              CONSERVATIVE_CONTRACT, SOURCE_MAP_CONTRACT, FACTUAL_REGISTER_CONTRACT,
              UNTRUSTED_CONTENT_CONTRACT + wrapUntrusted delimiters for prompt-injection
              hardening — see docs/threat-model.md C6).
  retrieval/  Embeddings, RRF fusion, chat/embedding HTTP providers, LLM flow router +
              embedding flow router. (Answer orchestration itself lives in api/watcher.)
  telemetry/  OpenTelemetry wiring (traces/metrics/log-trace mixin), off by default.
scripts/      migrate.mjs (custom migrator), test-db.mjs (throwaway-PG harness),
              e2e-jobs.ts / eval-api.ts / eval-gap-threshold.ts, deck/screenshot tooling.
deploy/       Loki + Grafana + Alloy logging stack config.
knowledge-bases/  Intentionally-empty drop dir for local dev KBs.
docs/         Product/architecture reference; docs/superpowers/ = agent-authored specs,
              plans, and task reports (never retro-edited — the design provenance).
```

Fast lookups: "what jobs exist / what's their payload?" → `packages/jobs/`. "how does
the watcher run a job?" → `apps/watcher/src/runners/`. "what does the API expose?" →
`apps/api/src/features/` + `src/app.ts`. "search/ranking/embeddings?" →
`packages/retrieval/`. "how do proposals get published/merged?" →
`apps/api/src/features/proposals/` + `apps/watcher/src/runners/publication.ts`.

## 5. Conventions and gotchas

- **ESM/NodeNext** — relative imports need explicit `.js` extensions (e.g.
  `./types.js`), even from `.ts` sources. TypeScript throughout.
- **Never cast through `unknown`** (or use `any` / hacky escape hatches) to silence the
  type checker. Fix the types properly.
- **No hacky workarounds** — fix the root cause the best way, don't paper over it.
- **Validate frequently, not at the end.** Run build + tests as you go so breakage is
  caught early. Don't batch a large change and validate once.
- **Commit AND push little and often** so there's always a reliable revert point.
- **Update documentation** alongside code (`docs/`, README, this skill) when behavior
  or structure changes.
- **Declare every output field on the job schema.** The broker validates completed
  outputs against `packages/jobs/src/schemas.ts` and **strips undeclared fields** before
  the API can persist them. Optional fields like `mapUpdates`, `uncoveredPoints`, and
  `provenance` have all hit this trap — if a new output field "mysteriously disappears",
  check the schema first.
- **The completion dispatcher persists before side effects.** `completeJob`
  (`apps/api/src/features/jobs/service.ts`) validates and stores the
  `{result, executor, usage?, provider?, model?}` envelope (`usage` = the watcher's summed
  provider-reported token spend, #241; `provider`/`model` = the executing runner's
  identity so spend can be priced per model against the operator's `AI_PRICING`
  table, `apps/api/src/platform/ai-pricing.ts`), *then* fans out side effects (proposal
  creation, folds, source-map updates, snapshot handling). A side-effect failure returns **HTTP 500 on purpose** so the
  watcher's retrying `complete()` hits the idempotent replay branch — re-running side
  effects only, never the paid generation. Don't "fix" that 500.
- **Local-git vs GitHub flows** — a flow's publish mode is derived from its destination:
  `flowPublishMode(deps, flowId)` in `apps/api/src/platform/repositories.ts` returns
  `local-git` when the destination is a `file://` git repo, else `github`. That one
  predicate drives publish routing, which scheduled tasks are offered (no PR-poll for
  local-git), and the console's Accept/Bin vs Publish/Merge UI. Don't re-sniff
  destinations ad hoc — key off it.
- **Docs staleness is flagged inline.** `docs/maintenance-redesign.md` carries an explicit
  "Superseded (2026-07)" callout for the removed shared-source-corpus design;
  `docs/superpowers/` plans/specs are historical records, never retro-edited. Trust the
  code when a doc and the source disagree.

### Commands

```bash
npm run build       # build all workspaces (ordered); build:libs for just @magpie/*
npm run typecheck   # tsc -p tsconfig.check.json --noEmit
npm run lint        # eslint .   (lint:fix to autofix)
npm run format:check
npm run deadcode    # knip — unused exports/files (kept strict)
npm test            # unit tests across workspaces
npm run test:db     # Postgres-backed tests (spins up a DB via scripts/test-db.mjs)
npm run db:migrate  # apply migrations
npm run e2e:jobs    # queue e2e harness; eval:api / eval:gap-threshold for eval scripts
npm run eval:golden # golden-question answer-quality regression gate (docs/golden-eval.md)
```

To actually **launch and drive the running stack** (Postgres → migrate → API → Watcher ×2
→ Web, with the local `.env` overrides needed because your `.env` (gitignored, deploy-only —
never committed) holds the prod config), use the **run-magpie** skill — don't re-derive the
launch recipe here.

### Task skills

For the common cross-cutting changes, invoke the matching skill instead of re-deriving the
steps — each is grounded in the real files and lists the gotchas:

- **add-a-job-type** — introduce/change a queued job: the `@magpie/jobs` contract, watcher
  runner, capability gate, enqueue, and output consumption.
- **write-a-migration** — the custom SQL migrator's `NNNN_` naming rule, prefix-uniqueness
  guard, append-only/no-rollback model, and how to apply + test a migration.
- **writing-magpie-tests** — `node:test` conventions, unit vs. Postgres-backed integration
  (`RUN_PG_INTEGRATION` + the throwaway-container harness), and the queue e2e/eval scripts.
- **magpie-local-troubleshooting** — diagnosing a broken local run (Docker, auth, config
  parsing, watcher `ECONNREFUSED`, CLI spawn errors).
- **propose-a-skill** — end-of-work retrospective: decide whether what you just did is worth
  capturing as a reusable skill, and draft one for approval. A Stop hook nudges you toward it
  once per session after substantial change.

### Planning notes

This repo is developed by AI agents under human review. Specs, plans, and task reports
live under `docs/superpowers/` (`specs/`, `plans/`, `sdd-notes/`). Check there for the
intent behind recent work — specs are the locked design decisions, plans are the
task-by-task TDD implementation scripts, and sdd-notes are per-task execution reports.
