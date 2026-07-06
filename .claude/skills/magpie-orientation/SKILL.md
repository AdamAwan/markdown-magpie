---
name: magpie-orientation
description: Architecture and conventions orientation for the Markdown Magpie repo. Use at the start of any development session on this repo to ramp up fast — explains the queue-only AI model, where code lives (apps/ and packages/), and the project conventions and gotchas. Pairs with run-magpie (for actually launching the stack).
---

# Orienting in Markdown Magpie

Markdown Magpie is a Git-backed Markdown knowledge maintenance system: it indexes docs,
answers questions with citations, logs weak answers, clusters them into knowledge gaps,
drafts Markdown improvements, and publishes them as pull requests for review.

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
  generative AI work done, model it as a job.
- **The watcher is required** for any AI work. Without a running watcher, `POST /api/ask`
  returns a 202 job that never completes. There is **no "direct mode"** — the old
  `AI_EXECUTION_MODE` was removed in the queue-only migration.
- **Maintenance orchestrators need ≥2 watchers.** A maintenance job (`verify_gap_closure`,
  the patrols, the reconciler) claims a watcher, then *blocks* in an API callback while the
  API bounded-waits on the follow-up AI jobs it enqueues. A watcher runs one job at a time,
  so those follow-ups can only be answered by a **second** watcher — with one watcher the
  orchestration self-starves and times out. `verify_gap_closure` handles that timeout
  safely (an incomplete re-ask is an infra failure that retries, never a false `still_open`
  — #150), and the console warns when only one watcher is connected. Run two locally (see
  the **run-magpie** skill).
- **The watcher has no database access.** API and watcher share only (a) the HTTP API
  and (b) the managed-checkout volume — which now also hosts read-only *source*
  workspaces for source-grounded jobs. The watcher gets a tightly scoped payload and
  posts results back; it does not read/write Postgres directly.
- **Seeding and gap drafting are agentic and source-grounded.** `draft_seed_document` and
  `draft_markdown_proposal` carry `SourceDescriptor[]` references (not sampled file content);
  the watcher resolves them to read-only checkouts and the agent explores them directly — CLI
  providers traverse the checkout with native tools, HTTP providers run a bounded
  `list_dir`/`read_file`/`grep` tool loop. (Patrols still use the old sampler until increment 3.)
- **Provider-neutral.** `AI_PROVIDER` selects `openai-compatible | azure-openai | codex |
  claude`. A watcher advertises a provider **capability** only when that provider's
  credentials are in its environment, and the API only routes a job to a capability a
  running watcher actually offers.
- **Job type vs. queue name.** The job *type* string names the Schedules UI row, the
  `/dataflow` box, and the `type=` filter. The pg-boss *queue name* equals the type for
  non-provider jobs, but **provider (AI) jobs fan out per provider** —
  `` `${type}__${provider}` `` (e.g. `answer_question__openai_compatible`), see
  `packages/jobs/src/catalog.ts`. Maintenance jobs are *orchestrators* that fan out into
  AI + GitHub jobs (see `docs/architecture.md` for the tier-1/tier-2 table). Most are
  scheduled on a cron, but **`verify_gap_closure`** is a maintenance job enqueued *on
  merge*: a merge no longer blindly resolves gaps — it re-asks the triggering questions and
  resolves only if the merged doc actually answers them (see `docs/question-logging.md`).

**Embeddings are the exception to "queue-only".** The API computes embeddings **inline**
(it holds an embedding provider) for both indexing (`apps/api/src/stores/embed-sections.ts`)
and query-time retrieval (`apps/api/src/stores/knowledge-index.ts`). So "the API never
calls a provider inline" is true for *chat/generative* work only — embeddings run in the
API process, not as watcher jobs.

Authoritative reading: this skill's claims were verified against source; the docs
[docs/architecture.md](../../../docs/architecture.md) and
[docs/ai-jobs.md](../../../docs/ai-jobs.md) are useful but predate some changes (e.g. they
imply *all* AI work including embeddings is queued — it isn't). Trust the code.

## 2. Where code lives

```text
apps/
  api/       HTTP API + job-queue owner. Owns permissions, retrieval orchestration,
             proposal creation, review workflow, scheduling/cron. Enqueues jobs and
             exposes the callbacks the watcher uses (e.g. retrieval, /api/gaps/reconcile).
  watcher/   Worker that claims jobs and calls the provider. Flows live under
             src/runners/ (chat, generative, maintenance, publication, cli, ...);
             capability advertisement in src/capabilities.ts.
  web/       Next.js review + admin console (Schedules, /dataflow, proposals review).
             UI is Emotion CSS-in-JS with a typed design-token theme (src/theme/) and a
             primitive library (src/components/ui/: Button, Badge, Chip, Surface, Field,
             Tabs, Stack/Row, …). There is NO global stylesheet — style with those
             primitives + colocated `styled` reading `p => p.theme.*`; never add a .css file.
  mcp/       MCP server — a client surface over the API (kb_ask, kb_search, kb_feedback).
             Only needed for MCP clients; skip for a normal run.
packages/
  core/       Shared domain types + provider interfaces.
  auth/       Auth0 token validation helpers.
  db/         Database schema + migrations.
  git/        Git sync + pull-request adapters (incl. local-git publisher).
  jobs/       Job contracts: JOB_TYPES, capabilities, input/output schemas, queue
              policies. Defined in src/types.ts + src/schemas.ts + src/catalog.ts.
              Start here when adding or changing a job.
  logger/     Shared structured logging.
  markdown/   Markdown parsing, frontmatter, sectioning by heading.
  prompts/    Shared AI prompt catalog.
  retrieval/  Search (keyword + vector), embeddings, ranking (RRF), routing, and
              answer orchestration.
```

Fast lookups: "what jobs exist / what's their payload?" → `packages/jobs/`. "how does
the watcher run a job?" → `apps/watcher/src/runners/`. "what does the API expose?" →
`apps/api/src/`. "search/ranking/embeddings?" → `packages/retrieval/`.

## 3. Conventions and gotchas

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
- **Local-git vs GitHub flows** — a flow's publish mode is derived from its destination:
  `flowPublishMode(deps, flowId)` in `apps/api/src/platform/repositories.ts` returns
  `local-git` when the destination is a `file://` git repo, else `github`. That one
  predicate drives publish routing, which scheduled tasks are offered (no PR-poll for
  local-git), and the console's Accept/Bin vs Publish/Merge UI. Don't re-sniff
  destinations ad hoc — key off it.

### Commands

```bash
npm run build       # build all workspaces (ordered)
npm run typecheck   # tsc -p tsconfig.check.json --noEmit
npm run lint        # eslint .   (lint:fix to autofix)
npm run format:check
npm test            # unit tests across workspaces
npm run test:db     # Postgres-backed tests (spins up a DB via scripts/test-db.mjs)
npm run db:migrate  # apply migrations
```

To actually **launch and drive the running stack** (Postgres → migrate → API → Watcher →
Web, with the local `.env` overrides needed because the committed `.env` is the prod
config), use the **run-magpie** skill — don't re-derive the launch recipe here.

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
intent behind recent work.
