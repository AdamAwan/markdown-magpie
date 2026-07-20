# Flows & Seeding

> **Status:** living spec (as-built). Source of truth for what a **flow** is and how a
> flow's knowledge base is **seeded** from its sources via a plan-centric, human-gated,
> self-seeding workflow. Follows the [spec conventions](./README.md#conventions).

## Purpose

A **flow** is a configured unit of knowledge: a set of sources, a destination, and an
authored voice/scope (persona, routing summary, charter). **Seeding** bootstraps a flow's
knowledge base from its sources — an agent proposes a document plan, a human reviews and
approves it, and approval drafts each item into a proposal that publishes like any other.

## Flow config model

- **F1** — A flow (`ConfiguredKnowledgeFlow`) has `id`, `name`, `sourceIds[]`,
  `destinationId`, and three optional authored fields with distinct **primary** roles:
  `persona` (answer voice — appended to the answer prompt, and **also** part of the flow's
  router embedding text), `routingSummary` (topical scope — the signal for embedding-based
  routing via `/api/route`; not a voice), and `charter` (coverage mission — consumed by
  seed planning only, never injected into answer prompts or router text). All three are
  additionally forwarded to the `outline_flow_seed` seed-planning agent as authoring
  context, so "primary role" is about where each field's authored intent *lives*, not the
  only place it is read.
- **F2** — There is **no `mode` field**. Publish mode is *derived* from the destination:
  a `file://` destination URL is `local-git`, otherwise `github`.
- **F3** — The system **never writes flow config**. A model-proposed charter/persona is
  carried run-scoped on the seed plan and flagged (`charterProposed` / `personaProposed`)
  so the console can offer a **copy-to-config** hint; flow config remains the only durable
  home. The `POST /api/config` route updates only `aiProvider`; no flow-config write
  endpoint exists.

## Seeding workflow (outline → review → approve → draft)

- **F4** — Seeding starts from the flow's **sources**, not a topic:
  `POST /api/flows/:id/outline` (one click, optional `notes` only; also the `kb_outline`
  MCP tool) enqueues the source-grounded `outline_flow_seed` job. An in-flight outline job
  for the flow is reused rather than double-planned.
- **F5** — The outline agent explores the flow's source repositories and proposes a
  complete document plan, plus a `proposedCharter`/`proposedPersona` **only when** the
  flow config lacks them.
- **F6** — On completion the plan is persisted in `seed_plans` behind a **human review
  gate** (idempotent on the outline job id; a fresh proposed plan supersedes an older
  still-proposed one). Reviewers edit charter/persona and items, then approve, revise, or
  dismiss (`/api/seed-plans/*`; the `kb_seed` MCP tool approves by plan id). Charter/persona
  are stored run-scoped as `input.charter ?? proposedCharter`.
- **F7** — **Approval is the only drafting entry point.** It sets the plan `approved`,
  then enqueues one `draft_seed_document` per non-dismissed item, each carrying the plan's
  run-scoped charter/persona and `seedPlanId`. Every approvable item MUST keep ≥1 non-empty
  coverage point (else 400 `coverage_required`). Approval is idempotent: items already
  carrying a `draftJobId` are skipped, so a re-approve after a mid-loop shed completes the
  remainder.
- **F8** — `draft_seed_document` **bypasses the demand-inference half** (gap clustering +
  the intent gate) because the approved plan *is* the reviewed intent. The resulting
  proposal is **clusterless** (carries `flowId` + `seedPlanId`) and still converges on the
  reconcile gate → `publish_proposal` path, ending at a reviewable PR.

## Self-seeding bootstrap

- **F9** — A per-flow hourly `seed_bootstrap` maintenance task auto-proposes a plan for a
  flow that has sources but a near-empty KB. It is **enqueue-and-return** (never bounded-
  waits — the plan waits for human review).
- **F10** — Bootstrap is self-quiescing via cheapest-first guards, returning a reason
  rather than proposing when any holds: `no_sources`, `kb_populated` (existing docs ≥
  `SEED_BOOTSTRAP_MAX_DOCS`, default 3), `plan_pending` (a proposed plan exists),
  `outline_in_flight`, `seed_proposals_open`, and `dismissed_unchanged` — the latest
  **dismissed** plan whose `sourceHash` equals the current sources' hash blocks re-proposal
  until the flow's sources change.

## Revise seed plan

- **F11** — `POST /api/seed-plans/:id/revise` (proposed plans only, else 409) enqueues a
  `revise_seed_plan` job carrying the current plan snapshot plus a free-text instruction.
  The job is **not source-grounded** — it reshapes the existing plan and never re-opens
  the flow's sources. It applies in place only if the plan is still `proposed` (a
  concurrent approve/dismiss wins; a stale revision is dropped), replacing items wholesale
  with fresh proposed ids.

## Seed plan entity

- **F12** — A `seed_plans` row has `status` (`proposed | approved | dismissed |
  superseded`), `origin`, run-scoped `charter`/`persona` with their `*_proposed` flags,
  `items` (JSONB; each item `proposed | approved | dismissed`, with an optional
  `draftJobId`), `rationale`, a unique `outline_job_id`, and `source_hash`. There is no
  "drafted" plan state — drafting is tracked per item via `draftJobId` while the plan stays
  `approved`. Status-transition rules ("only while proposed") are enforced in the service.

## Job contracts

- **F13** — `outline_flow_seed` — capability `provider`, expiry 10 min, repairable, and
  **interactive** (one of exactly `["answer_question", "outline_flow_seed"]`).
- **F14** — `draft_seed_document` — capability `provider`, expiry 15 min, maintenance-AI
  (not interactive; admitted through the fan-out budget). `revise_seed_plan` — capability
  `provider`, expiry 10 min. `seed_bootstrap` — capability `maintenance` (not an AI job),
  expiry 1h, hourly per flow.

## Key constants

| Constant | Default | Where |
| --- | --- | --- |
| `SEED_BOOTSTRAP_MAX_DOCS` | 3 | `apps/api/src/platform/config.ts` |
| `outline_flow_seed` expiry | 10 min | `packages/jobs/src/catalog.ts` |
| `draft_seed_document` expiry | 15 min | `packages/jobs/src/catalog.ts` |

## HTTP endpoints

- `POST /api/flows/:flowId/outline`, `POST /api/flows/:flowId/seed-bootstrap/run`,
  `GET /api/flows/:flowId/seed-plans`.
- `GET /api/seed-plans/:id`, `PATCH /api/seed-plans/:id` (edit, proposed only),
  `POST /api/seed-plans/:id/{approve,revise,dismiss}`.
- `GET /api/config`, `POST /api/config` (aiProvider only), `POST /api/admin/reset`.
- The legacy `POST /api/flows/:flowId/seed` (raw items) is **removed** (404).

## Code map

| Concern | Code |
| --- | --- |
| Flow config type & load | `apps/api/src/stores/knowledge-repositories.ts`, `apps/api/src/features/config/service.ts`, `apps/api/src/platform/repositories.ts` (`flowPublishMode`) |
| Seed service (outline/approve/revise/bootstrap) | `apps/api/src/features/seed/{service,routes,schema}.ts` |
| Seed plan store | `apps/api/src/stores/{seed-plan-store,postgres-seed-plan-store}.ts` |
| Seed proposal completion | `apps/api/src/features/proposals/service.ts` (`createSeedProposalFromCompletedJob`) |
| Copy-to-config flags | `packages/core/src/index.ts` (`SeedPlan`) |
| Job contracts | `packages/jobs/src/{schemas,catalog}.ts` |
| MCP tools | `apps/mcp/src/{main,kb-client}.ts` (`kb_outline`, `kb_seed`) |

## Tests (behavioural contract)

`apps/api/src/features/seed/{routes,service}.test.ts`,
`apps/api/src/features/config/{service,routes.flow-scope}.test.ts`,
`apps/api/src/stores/{seed-plan-store,postgres-seed-plan-store}.test.ts`,
`apps/api/src/features/proposals/service.test.ts`,
`apps/watcher/src/runners/maintenance.test.ts`,
`packages/jobs/src/{catalog,schemas}.test.ts`.

## Provenance (design history)

Consolidates: `docs/superpowers/specs/2026-07-03-flow-seeding-design.md`,
`2026-07-09-self-seeding-flows-design.md`, `2026-07-16-revise-seed-plan-design.md`,
`2026-06-30-flow-selection-design.md` (flow config surface). Flow *routing* (the
embedding algorithm those fields feed) is specified in [retrieval.md](./retrieval.md).

> **Drift found while writing:** ① a flow has no stored `mode` field — publish mode is
> derived from the destination URL (`flowPublishMode`); ② the legacy
> `POST /api/flows/:flowId/seed` endpoint is removed (a test asserts 404); ③ interactive
> AI job types are exactly `answer_question` and `outline_flow_seed` — `draft_seed_document`
> / `revise_seed_plan` / `seed_bootstrap` are not interactive.
>
> **Drift found on review (2026-07-20):** ④ F1 previously said `routingSummary` was used
> "only" for routing and framed `persona` as answer-prompt-only. Both overclaimed: the
> flow router's embedding text is `[name, routingSummary, persona]`
> (`apps/api/src/features/route/service.ts:40`), so `persona` also feeds routing, and
> `persona`/`routingSummary`/`charter` are **all** passed to the `outline_flow_seed`
> job as seed-planning context (`apps/api/src/features/seed/service.ts:104-106`). F1
> now states primary roles without the false exclusivity.
