# Self-seeding flows: source-grounded seed planning

**Status:** approved · **Date:** 2026-07-09

Make seeding start from the sources instead of from a human-typed topic. The planning
step becomes a source-grounded agentic job that explores the flow's source repositories,
proposes a complete document plan (and, when the flow lacks one, a charter/persona), and
persists that plan for human review. A sparse-flow auto-trigger proposes a plan for any
flow that has sources but an empty knowledge base. The human gates are unchanged in kind:
review/edit/approve the plan before drafting, review PRs before merge.

## Problem

Today's seeding (`apps/api/src/features/seed/`, `/seed` console page) requires the human
to supply the "what should exist" knowledge:

1. The user types a **topic** (+ optional notes) → `outline_flow_seed` proposes
   `SeedItem[]`. The outline job is **not source-grounded** — it sees only the topic and
   sections retrieved from the flow's *existing destination docs*, so its plan is
   imagined from the topic rather than derived from what the sources actually contain.
2. The user edits items client-side (the outline output lives only as job output and is
   lost on navigation) and posts them to `/seed` → one source-grounded
   `draft_seed_document` per item → proposal → PR via the reconcile gate.

Three shortfalls (user-confirmed): the human should not need to supply topics; the
outline is not source-grounded, so its quality is poor; one topic at a time cannot
bootstrap a whole flow.

## Decisions (locked)

- **Approach:** upgrade `outline_flow_seed` into a source-grounded whole-flow planning
  job (Approach A). The survey→fan-out evolution (Approach B) is explicitly deferred; the
  plan-persistence and review layer is designed so B can slot in behind it later.
- **Human gate:** the plan-review gate stays. Nothing is drafted until a human approves
  the plan (per item). PR review remains downstream as usual.
- **Trigger:** a one-click "Propose seed plan" per flow (no topic input), **plus** a
  per-flow scheduled sparse-flow check that auto-proposes a plan when a flow has sources
  but a near-empty destination.
- **Scope signal:** a new optional `charter` field on `KNOWLEDGE_FLOWS` entries — *what
  this KB should cover* — distinct from `persona` (*audience/voice*) and from
  `routingSummary` (short topical blurb consumed by the embedding flow router). All
  three are optional, config-only, operator-owned.
- **Charter is an output before it is an input:** when the flow lacks a charter (or
  persona), the planning job proposes one from its exploration. The system **never
  writes flow config**; the review UI displays the proposal with a copy-to-config
  affordance, and the (possibly human-edited) charter is stored on the *plan* and passed
  into that run's drafting jobs. If it is never pasted into config, the next planning
  run simply proposes one again.

## Components

### 1. `@magpie/core` + config: `charter` on flows

- Add optional `charter?: string` to the knowledge-flow config type and to the
  `KNOWLEDGE_FLOWS` parser (`apps/api/src/stores/knowledge-repositories.ts`), alongside
  `persona` and `routingSummary`.
- Charter is **planning-scope guidance only**: consumed by seed planning (and available
  to future planners), not injected into answer/drafting voice prompts the way persona
  is. It is not part of the router's flow text.

### 2. `outline_flow_seed` becomes source-grounded whole-flow planning

Contract changes (`packages/core`, `packages/jobs/src/schemas.ts`):

- **Input:** `flowId`, `sources: SourceDescriptor[]` (same projection
  `draft_seed_document` uses), `existingDocuments`, `persona?`, `charter?`,
  `routingSummary?`, `notes?` (free-text steer). **`topic` is removed** — `notes`
  replaces it as an optional steer. `origin: "manual" | "auto"` records what triggered
  the run.
- **Output:** `{ items: SeedItem[], rationale, proposedCharter?, proposedPersona?,
  mapUpdates? }`. `proposedCharter`/`proposedPersona` are emitted only when the flow
  lacked them. `mapUpdates` follows the existing source-map contract. Every field is
  declared on the output schema (the broker strips undeclared fields).
- **Watcher:** add `outline_flow_seed` to `sourceGroundedInputSchema()` in
  `apps/watcher/src/source-workspace.ts` so the agent gets read-only source workspaces
  (CLI providers traverse natively; HTTP providers use the bounded tool loop). Source-map
  hints are injected as unverified hints like the other source-grounded jobs.
- **Prompt** (`packages/prompts`, `outline-flow-seed`): rewritten. Explore the sources
  directly; propose a complete, non-overlapping document plan for the flow — not one
  topic's worth — fitted to `existingDocuments` (never restate what is covered); scope by
  charter when given, else propose `proposedCharter` (and `proposedPersona` when persona
  is absent); contribute `mapUpdates`; coverage points must be specific and grounded in
  files actually read.

Accepted risk: on very large corpora an HTTP-provider run may plan shallowly (24-step /
400 KB tool-loop budget). CLI providers have no such ceiling; source-map hints
accumulate. Approach B (survey → per-area outline fan-out) is the designated evolution
and reuses this plan layer unchanged.

### 3. Persisted seed plans + review (API)

- **Migration 0051** — `seed_plans`: `id`, `flow_id`, `status`
  (`proposed | approved | dismissed | superseded`), `charter` (text, the run-scoped
  charter: flow config's if set, else the proposal, as later edited by the reviewer),
  `persona` (same treatment), `items` JSONB (each item: SeedItem fields + per-item
  status `proposed | approved | dismissed` + reviewer edits), `origin`
  (`manual | auto`), `outline_job_id`, `notes`, `source_hash` (hash of the flow's
  source descriptors at planning time; consumed by the bootstrap dismissal guard, §5),
  timestamps. Append-only migrator rules per `write-a-migration`.
- **Completion handler:** `outline_flow_seed` completion creates a `proposed` plan row
  (idempotent on `outline_job_id`, following `createSeedProposalFromCompletedJob`'s
  pattern in the jobs-completion dispatcher). A new proposed plan **supersedes** any
  older still-`proposed` plan for the same flow.
- **Routes** (extend `apps/api/src/features/seed/`, same scopes as today —
  `manage:jobs` + flow `manage` capability):
  - `POST /api/flows/:flowId/outline` — body `{ notes? }` (topic removed). Guards: no
    in-flight outline job for the flow (reuse), enqueues with `origin: "manual"`.
  - `GET /api/flows/:flowId/seed-plans` (list, newest first) and
    `GET /api/seed-plans/:id`.
  - `PATCH /api/seed-plans/:id` — edit charter/persona text, edit items, set per-item
    status. Only while `proposed`.
  - `POST /api/seed-plans/:id/approve` — flips to `approved`, enqueues one
    `draft_seed_document` per approved item carrying the plan's charter + persona;
    records the enqueued job ids on the plan items for progress display.
  - `POST /api/seed-plans/:id/dismiss`.
- The legacy `POST /api/flows/:flowId/seed` (raw `SeedItem[]` → draft jobs) is
  **removed**; plan approval is the only drafting entry point. The MCP `kb_seed` tool is
  reworked to operate on plans (see §7).

### 4. `draft_seed_document` carries charter/persona

- Input gains optional `charter?` and `persona?` (schema-declared, prompt-consumed:
  persona shapes voice, charter bounds scope). `seedFlow` service becomes plan-driven
  (`approvePlan`), resolving flow/sources/destination exactly as today.
- Proposals record the `seed_plan_id` (nullable column on `proposals`, part of migration
  0051) so the plan view can show drafting/publication progress per item.
- Reconcile gate, publication, closure verification: unchanged.

### 5. Sparse-flow auto-trigger

- New entry in `flowTaskTemplates` (`apps/api/src/scheduling/task-registry.ts`):
  `seed-bootstrap`, default cron hourly, job type `seed_bootstrap` (new **non-provider
  maintenance job**, retry 2). The watcher's maintenance runner POSTs a thin API
  endpoint (`POST /api/flows/:flowId/seed-bootstrap/run`), matching the patrol pattern;
  the run-lock advisory lock serialises overlapping runs.
- The endpoint checks, in order, and **no-ops** unless all hold:
  1. flow has ≥1 source;
  2. destination indexed document count < `SEED_BOOTSTRAP_MAX_DOCS` (default 3);
  3. no `proposed` plan pending for the flow;
  4. no in-flight `outline_flow_seed` job for the flow;
  5. no open seed-originated proposals for the flow.
- When all hold it enqueues `outline_flow_seed` with `origin: "auto"` and returns —
  unlike the patrol orchestrators it does **not** bounded-wait on the job (the plan
  lands via the completion handler). Self-quiescing: once a plan is pending, items are
  drafting, or the KB has docs, it no-ops.
- Dismissing an auto-proposed plan suppresses re-proposal until the flow's source
  descriptors change (store the source-descriptor hash on the dismissed plan; the
  bootstrap check also skips when the latest `dismissed` plan's hash matches the current
  one). This prevents an hourly re-litigation of a human "no".

### 6. Console (`apps/web`)

`/seed` becomes plan-centric:

- Flow picker + "Propose seed plan" button (optional steer-notes field; no topic input)
  + pending outline-job indicator.
- Plans list per flow (proposed / approved / dismissed with timestamps and origin
  badges).
- Plan review screen: editable charter/persona block at the top when the plan carries
  proposals (with a "copy to `KNOWLEDGE_FLOWS` config" hint + copy button), per-item
  edit/approve/dismiss, approve-plan and dismiss-plan actions, and drafting/proposal
  progress per item after approval.
- Existing UI primitives only (`src/components/ui/`), no new CSS files.

### 7. MCP (`apps/mcp`)

- `kb_outline`: `topic` becomes optional `notes` (steer), returns the job id as today.
- `kb_seed`: reworked from "post raw items" to "approve a plan" — takes a plan id
  (optionally with per-item selections). Tool descriptions updated.

## Error handling

- Planning-job failure surfaces as a normal failed job (`/jobs`); no plan row is
  created. The auto-trigger's in-flight/pending guards prevent pile-up; it retries at
  the next cron tick.
- A charterless flow whose plan lacks `proposedCharter` is tolerated: the review screen
  simply shows an empty editable field.
- Plan approval enqueues serially like today's `seedFlow`; a mid-loop enqueue failure
  leaves already-enqueued items recorded on the plan and returns 500 — re-approving is
  idempotent per item (items with recorded job ids are skipped).
- Concurrency: approving/patching a non-`proposed` plan returns 409; the completion
  handler's supersede step and the bootstrap guards are both idempotent.

## Testing

- **Unit:** knowledge-config parser (`charter`), outline/draft schema round-trips
  (including field-stripping property), prompt-catalog invariants, plan completion
  handler (create/supersede/idempotency), approve/dismiss/patch service logic including
  the partial-approve replay, bootstrap no-op matrix (each guard), source-workspace
  schema switch now including `outline_flow_seed`.
- **PG integration** (`RUN_PG_INTEGRATION` harness): `seed_plans` store CRUD +
  supersede, seed routes end-to-end (outline → completion → patch → approve → draft
  jobs enqueued with charter), migration applies cleanly.
- **Web:** plan review screen rendering states (proposed with/without charter proposal,
  approved with progress), per existing component-test conventions.

## Documentation

Update `docs/ai-jobs.md` (outline contract, new `seed_bootstrap` job), `docs/api.md`
(seed-plan endpoints, removed legacy seed route), `docs/architecture.md` §seeding,
`docs/mcp.md` (tool changes), and the `magpie-orientation` skill (§2.13 seeding, job
counts, migration count).

## Explicitly out of scope

- Approach B survey → per-area fan-out (designated evolution, same plan layer).
- System-written flow config (charter/persona always operator-pasted).
- Proposing `routingSummary` (could ride the same mechanism later).
- A continuous "coverage patrol" beyond the sparse-flow bootstrap.
