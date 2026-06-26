# Retire Scheduled-Crunch Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the whole-knowledge-base scheduled-crunch flow (`crunch_knowledge_base`, `trigger_scheduled_crunch`, `publish_crunch`) now that the patrol lenses cover it, while keeping source-change-sync working and the scheduled-task editor alive.

**Architecture:** Sequenced so every commit compiles and tests stay green. First rename the shared plan vocabulary (green→green) and relocate `changesetFromPlan` out of crunch, then remove crunch consumers (watcher, API, web) before removing the leaf job-type/schema/prompt definitions, then drop the DB tables, then docs.

**Tech Stack:** TypeScript, Node test runner, Zod, npm workspaces (`@magpie/core`, `@magpie/jobs`, `@magpie/prompts`, `@magpie/api`, `@magpie/watcher`, web), Postgres migrations.

## Global Constraints

- TDD: where a count/route assertion exists, change the test first (RED), watch it fail, then implement. Pure deletions rely on existing tests + `typecheck` + `deadcode` staying green.
- Never relax `knip` config (`npm run deadcode` STRICT) — fix orphaned exports by de-exporting/deleting.
- `isValidCron` / `nextCronTime` in `@magpie/core` stay — used by `features/scheduled-tasks/routes.ts` and the surviving schedule editor.
- Run package tests from repo root via `npm test -w <pkg>` or `node --import tsx --test <file>`; root-cwd globs resolve stale dist.
- Postgres store tests skip without `DATABASE_URL`.
- Rename mapping (apply verbatim everywhere): `CrunchPlan`→`MaintenancePlan`, `CrunchOperation`→`MaintenanceOperation`, `CrunchOperationKind`→`MaintenanceOperationKind`, `CrunchFileWrite`→`MaintenanceFileWrite`, `crunchOperationSchema`→`maintenanceOperationSchema`, literal `"crunch_plan"`→`"maintenance_plan"`. (Crunch-run/job-specific names — `CrunchRun`, `CrunchRunTrigger`, `CrunchKnowledgeBaseJob*` — are NOT renamed; they are deleted with the feature.)

---

### Task 1: Rename the shared plan vocabulary (green→green refactor)

**Files:**
- Modify: `packages/core/src/index.ts` (CrunchPlan/CrunchOperation/CrunchOperationKind/CrunchFileWrite + both `"crunch_plan"` literals at the crunch input and SourceChangeSync input; `SourceChangeSyncJobOutput`, `CrunchRun.plan`, source-sync plan fields)
- Modify: `packages/jobs/src/schemas.ts` (import of `CrunchPlan`, `crunchOperationSchema`, both `z.literal("crunch_plan")`, `satisfies z.ZodType<CrunchPlan>`)
- Modify: `apps/api/src/stores/source-sync-store.ts`, `postgres-source-sync-store.ts`, `crunch-store.ts`, `postgres-crunch-store.ts`, `postgres-crunch-store.test.ts` (CrunchPlan type refs)
- Modify: `apps/api/src/features/crunch/service.ts` + `service.test.ts`, `apps/api/src/features/source-sync/service.ts` (CrunchPlan/maintenanceOperationSchema refs)
- Modify: `apps/watcher/src/runners/publication.ts` (CrunchPlan refs if any)
- Modify: `apps/web/src/lib/types.ts` (CrunchFileWrite/CrunchOperation/CrunchPlan re-exports) and any web consumer (`CrunchPanel.tsx` uses `run.plan.operations` via `CrunchRun`, not the renamed types — verify)

**Interfaces:**
- Produces: `MaintenancePlan`, `MaintenanceOperation`, `MaintenanceOperationKind`, `MaintenanceFileWrite`, `maintenanceOperationSchema`, literal `"maintenance_plan"`.

- [ ] **Step 1: Inventory every reference**

Run: `git grep -n -E "CrunchPlan|CrunchOperation|CrunchFileWrite|crunchOperationSchema|crunch_plan" -- "*.ts" "*.tsx"` (ignore `docs/`).
Expected: the sites listed under Files above.

- [ ] **Step 2: Rename in `packages/core/src/index.ts`**

Rename the interfaces/types/literals per the mapping. Keep `CrunchRun`, `CrunchRunTrigger`, `CrunchKnowledgeBaseJobInput/Output` for now (deleted in later tasks) but point their internals at the renamed `Maintenance*` types (e.g. `CrunchKnowledgeBaseJobOutput = MaintenancePlan`, `expectedOutput: "maintenance_plan"`). Update the comment at line ~676 that names `CrunchPlan`.

- [ ] **Step 3: Rename in `packages/jobs/src/schemas.ts`**

`import { MaintenancePlan } ...`; `maintenanceOperationSchema = z.object({...})`; both `expectedOutput: z.literal("maintenance_plan")`; `satisfies z.ZodType<MaintenancePlan>`.

- [ ] **Step 4: Rename across API + watcher + web type refs**

Apply the mapping in the store files, crunch service (+test), source-sync service, publication runner, and `apps/web/src/lib/types.ts`.

- [ ] **Step 5: Build the leaf packages and typecheck**

Run: `npm run build -w @magpie/core && npm run build -w @magpie/jobs` (if build scripts exist) then `npm run typecheck`.
Expected: exit 0, no `Cannot find name 'CrunchPlan'`.

- [ ] **Step 6: Run the guarding suites**

Run: `npm test -w @magpie/jobs` ; `node --import tsx --test "apps/api/src/features/source-sync/**/*.test.ts" "apps/api/src/features/crunch/**/*.test.ts" "apps/api/src/stores/**/*.test.ts"`.
Expected: all pass (green→green; the rename changed no behaviour).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(crunch): rename shared plan vocabulary to Maintenance*"
```

---

### Task 2: Relocate `changesetFromPlan` out of the crunch service

**Files:**
- Modify: `apps/api/src/features/source-sync/service.ts` (define/host `changesetFromPlan`, drop the `../crunch/service.js` import)
- Modify: `apps/api/src/features/crunch/service.ts` (remove the now-unused export if nothing else in crunch needs it — it does at line ~210, so keep a local copy in crunch until crunch is deleted in Task 4; the source-sync copy is the surviving one)
- Modify: `apps/api/src/features/source-sync/` test (move the `changesetFromPlan applies deletes then writes` test out of `crunch/service.test.ts` into a source-sync test so the behaviour stays covered after Task 4 deletes the crunch test)

**Interfaces:**
- Produces: `changesetFromPlan(plan: MaintenancePlan): ChangesetChange[]` owned by source-sync.

- [ ] **Step 1: Move the test (RED)**

Cut the `changesetFromPlan applies deletes then writes with last-write-wins per path` test from `apps/api/src/features/crunch/service.test.ts` into a new/existing source-sync test importing from `../source-sync/service.js`.
Run: `node --import tsx --test "apps/api/src/features/source-sync/**/*.test.ts"`.
Expected: FAIL — `changesetFromPlan` not exported from source-sync service.

- [ ] **Step 2: Host `changesetFromPlan` in source-sync**

Move the function body (currently `crunch/service.ts:161`) into `source-sync/service.ts`, exported, typed `MaintenancePlan`. Replace the `import { changesetFromPlan } from "../crunch/service.js"` with the local definition. Keep crunch's internal use working by leaving its own private copy until Task 4 (or import from source-sync — choose whichever keeps both green; prefer leaving crunch's copy since crunch is about to be deleted).

- [ ] **Step 3: Verify green**

Run: `node --import tsx --test "apps/api/src/features/source-sync/**/*.test.ts" "apps/api/src/features/crunch/**/*.test.ts"`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(source-sync): own changesetFromPlan ahead of crunch removal"
```

---

### Task 3: Remove crunch from the watcher

**Files:**
- Modify: `apps/watcher/src/runners/maintenance.ts` (drop `trigger_scheduled_crunch` from `MAINTENANCE_JOB_TYPES`, its dispatch, and `triggerScheduledCrunch` method)
- Modify: `apps/watcher/src/http-client.ts` (drop `triggerScheduledCrunch`, `crunchExecutionContext`, `CrunchExecutionContext`)
- Modify: `apps/watcher/src/job-prompts.ts` + `job-prompts.test.ts` (drop the `crunch_knowledge_base` case)
- Modify: `apps/watcher/src/runners/publication.ts` (drop the `publish_crunch` branch, `buildCrunchPullRequestBody`, crunch branch derivation; the local `changesetFromPlan` stays only if a surviving path uses it — else delete)
- Modify: watcher runner test fakes that implement `WatcherApi` (`chat.test.ts`, `publication.test.ts`, `refresh-pull-requests.test.ts`, `maintenance.test.ts`) — remove the now-deleted methods from each `fakeApi`

- [ ] **Step 1: Update maintenance test (RED)**

In `apps/watcher/src/runners/maintenance.test.ts` remove the `trigger_scheduled_crunch` support assertion / tests and the `triggerScheduledCrunch` fake.
Run: `node --import tsx --test apps/watcher/src/runners/maintenance.test.ts`.
Expected: FAIL to compile/run while `maintenance.ts` still references the removed type.

- [ ] **Step 2: Remove crunch from maintenance + http-client + job-prompts + publication**

Delete the code listed in Files. For `publication.ts`, confirm whether the runner still serves `publish_proposal`/changeset publishing (it does) and only remove the crunch branch + crunch-only helpers.

- [ ] **Step 3: Update the other fakes**

Remove `triggerScheduledCrunch` / `crunchExecutionContext` from every `fakeApi` in the four watcher runner tests.

- [ ] **Step 4: Verify watcher focused tests**

Run: `node --import tsx --test apps/watcher/src/runners/maintenance.test.ts apps/watcher/src/job-prompts.test.ts apps/watcher/src/runners/publication.test.ts apps/watcher/src/runners/refresh-pull-requests.test.ts apps/watcher/src/runners/chat.test.ts`.
Expected: PASS (ignore the known pre-existing publication Windows path-separator + stale-dist `@magpie/git` failures if they reappear unrelated to this change).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(watcher): drop scheduled-crunch + publish_crunch handling"
```

---

### Task 4: Remove the crunch API feature, stores, and wiring

**Files:**
- Delete: `apps/api/src/features/crunch/` (routes.ts, service.ts, schema.ts, service.test.ts, any others)
- Delete: `apps/api/src/stores/crunch-store.ts`, `postgres-crunch-store.ts`, `postgres-crunch-store.test.ts`
- Delete/trim: `apps/api/src/crunch.test.ts` — keep the `isValidCron`/`nextCronTime` cron-util tests by moving them to `packages/core` (or a non-crunch API test) if this file is their only coverage; delete the InMemoryCrunchStore portion
- Modify: `apps/api/src/app.ts` (remove `crunchRoutes` import + `/crunch` mount)
- Modify: `apps/api/src/context.ts` + `apps/api/src/test-support/context.ts` (remove `crunchRuns` store wiring)
- Modify: `apps/api/src/platform/stores.ts` (remove `CRUNCH_STORE`)
- Modify: `apps/api/src/features/jobs/service.ts` (remove `attachCrunchPlanFromCompletedJob` + `recordCrunchPublicationFromCompletedJob` dispatch)
- Modify: `apps/api/src/jobs/schedule-reconciler.ts` (remove crunch-schedule build/keys; keep generic scheduled-task reconcile)
- Modify: `apps/api/src/stores/reset-stores.test.ts` (drop the `trigger_scheduled_crunch` job reference)

- [ ] **Step 1: Add the route-gone assertion (RED)**

In `apps/api/src/app.test.ts` add:

```ts
test("GET /crunch/runs returns not_found after retirement", async () => {
  const app = buildApp(makeTestContext());
  const res = await app.request("/crunch/runs");
  assert.equal(res.status, 404);
});
```

Run: `node --import tsx --test apps/api/src/app.test.ts`.
Expected: FAIL — route still mounted (returns 200/other).

- [ ] **Step 2: Delete the feature, stores, and wiring**

Remove the files/lines in Files. Follow typecheck errors to find every dangling reference.

- [ ] **Step 3: Verify the route + suites**

Run: `node --import tsx --test apps/api/src/app.test.ts apps/api/src/stores/reset-stores.test.ts apps/api/src/jobs/schedule-reconciler.test.ts apps/api/src/features/jobs/service.test.ts`.
Expected: PASS, including the new 404 assertion.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): remove the crunch feature, stores, and wiring"
```

---

### Task 5: Repurpose the web Crunch section into Schedules

**Files:**
- Rename/rewrite: `apps/web/src/components/CrunchPanel.tsx` → `SchedulesPanel.tsx` (keep the scheduled-tasks table, `CRON_PRESETS`, `ScheduleRow`/`ScheduleEditor`, `isValidCron`; drop the flow-crunch `settings` entries, `CrunchRunCard`, the recent-runs section, and `onPublish`/`onRun`/`onSaveSchedule`/`runs`/`settings` props; update heading + hint copy)
- Rename: `apps/web/src/app/crunch/page.tsx` → `apps/web/src/app/schedules/page.tsx` (render `SchedulesPanel`; pass only `scheduledTasks`/`runScheduledTask`/`saveScheduledTask`/`flows`/`loading`)
- Modify: `apps/web/src/lib/sections.ts` (entry `crunch`/`/crunch`/`"Crunch"`/glyph `Cr` → `schedules`/`/schedules`/`"Schedules"`/glyph `Sc`)
- Modify: `apps/web/src/lib/types.ts` (`ConsoleSection` union: `"crunch"` → `"schedules"`; drop now-unused `CrunchRun`/`CrunchSettingsView` re-exports if nothing else uses them; keep `MaintenancePlan`/`MaintenanceOperation`/`MaintenanceFileWrite` only if still referenced)
- Modify: `apps/web/src/components/ConsoleProvider.tsx` (drop `crunchRuns`/`crunchSettings` state, the `/crunch/*` polling + refresh, `runCrunch`/`saveCrunchSchedule`/`publishCrunchRun`; keep `scheduledTasks`/`runScheduledTask`/`saveScheduledTask`)

- [ ] **Step 1: Update the section list (RED if a test asserts sections)**

If `apps/web` has a `sections` test, update it to expect `schedules` not `crunch` and run it (expect FAIL). If no web test exists, this task is verified by typecheck + a manual route check.

- [ ] **Step 2: Rewrite the panel + page + provider + sections + types**

Apply the changes in Files. The schedules table already renders `scheduledTasks`; removing the crunch `settings` source just shortens the `entries` array to the `scheduledTasks` branch.

- [ ] **Step 3: Typecheck the web app**

Run: `npm run typecheck`.
Expected: exit 0, no references to removed crunch handlers/state/types.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): repurpose the Crunch section into Schedules"
```

---

### Task 6: Remove the leaf job-type, schema, and prompt definitions

**Files:**
- Modify: `packages/jobs/src/types.ts` (remove `crunch_knowledge_base`, `trigger_scheduled_crunch`, `publish_crunch` from the union + any `aiJobTypes`/group lists)
- Modify: `packages/jobs/src/catalog.ts` + `catalog.test.ts` (remove the three `define(...)` entries; update count assertions)
- Modify: `packages/jobs/src/schemas.ts` + `schemas.test.ts` (remove `crunchKnowledgeBaseInput/OutputSchema`, `triggerScheduledCrunchInput/OutputSchema`, `publishCrunchInput/OutputSchema`; keep `maintenanceOperationSchema` + the source-sync schemas)
- Modify: `packages/core/src/index.ts` (remove `CrunchKnowledgeBaseJobInput/Output`, `CrunchRun`, `CrunchRunTrigger`, `CrunchSettings` and other crunch-only types now that no code references them — let `deadcode`/typecheck confirm)
- Modify: `packages/prompts/src/catalog.ts` + `catalog.test.ts` (remove the `crunch-knowledge-base` entry; update the count)
- Modify: `apps/api/src/app.test.ts:197` (prompt count 18 → 17)

- [ ] **Step 1: Update count/union assertions (RED)**

In `packages/jobs/src/catalog.test.ts` and `schemas.test.ts`, `packages/prompts/src/catalog.test.ts`, and `apps/api/src/app.test.ts`, lower the expected counts and remove crunch-type assertions.
Run: `npm test -w @magpie/jobs ; npm test -w @magpie/prompts ; node --import tsx --test apps/api/src/app.test.ts`.
Expected: FAIL — actual counts still include crunch.

- [ ] **Step 2: Remove the definitions**

Delete the crunch entries from types/catalog/schemas/prompts/core. Follow typecheck to clear stragglers.

- [ ] **Step 3: Verify counts green**

Run: `npm test -w @magpie/jobs ; npm test -w @magpie/prompts ; node --import tsx --test apps/api/src/app.test.ts`.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(jobs): remove crunch job types, schemas, and prompt"
```

---

### Task 7: Drop the crunch database tables

**Files:**
- Create: `packages/db/migrations/0031_drop_crunch.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Retire the scheduled-crunch flow: the patrol lenses replace it.
DROP TABLE IF EXISTS crunch_runs;
DROP TABLE IF EXISTS crunch_settings;
```

- [ ] **Step 2: Confirm migration ordering**

Run: `git ls-files packages/db/migrations | sort | tail -3`.
Expected: `0031_drop_crunch.sql` is the highest-numbered file; `0010_crunch.sql` is unchanged.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0031_drop_crunch.sql
git commit -m "feat(db): drop crunch_runs and crunch_settings"
```

---

### Task 8: Docs, dead-code sweep, and full verification

**Files:**
- Modify: `docs/maintenance-redesign.md` (mark step 6 done)
- Modify: memory `maintenance-redesign-progress.md` (record step 6 shipped)

- [ ] **Step 1: Dead-code sweep**

Run: `npm run deadcode`.
Expected: exit 0. If knip flags newly-orphaned exports (former store factories, publication helpers, removed schema exports), de-export or delete them and re-run until clean.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`.
Expected: exit 0.

- [ ] **Step 3: Full test gates**

Run: `npm test -w @magpie/jobs` ; `npm test -w @magpie/prompts` ; `node --import tsx --test "apps/api/src/**/*.test.ts"` ; watcher focused tests.
Expected: all green except the documented pre-existing watcher failures (publication Windows path separator; stale-dist `@magpie/git`).

- [ ] **Step 4: Update docs + memory, commit**

```bash
git add -A
git commit -m "docs(crunch): mark maintenance-redesign step 6 complete"
```

- [ ] **Step 5: Finish the branch and open the PR**

Use superpowers:finishing-a-development-branch → push `codex/retire-scheduled-crunch` → open a PR against `main`.

## Self-Review

- **Spec coverage:** Task 1+2 cover the rename/relocate; Task 3 watcher; Task 4 API feature/stores/wiring/schedule-reconciler/job-completion; Task 5 web Schedules; Task 6 leaf job-types/schemas/prompt + counts; Task 7 DB drop; Task 8 docs + cron-util preservation (folded into Task 4 Step 2) + knip. `isValidCron`/`nextCronTime` preserved (Global Constraints + Task 4). All spec sections mapped.
- **Type consistency:** rename mapping is defined once in Global Constraints and referenced by name throughout; `changesetFromPlan` signature stated in Task 2 Interfaces uses the renamed `MaintenancePlan`.
- **Ordering:** leaf definitions (Task 6) removed only after all consumers (Tasks 3–5) are gone, so every commit compiles.
