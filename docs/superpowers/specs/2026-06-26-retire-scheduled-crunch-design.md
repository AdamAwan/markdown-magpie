# Retire the Scheduled-Crunch Flow — Design

**Date:** 2026-06-26
**Status:** Approved
**Step:** 6 (final) of `docs/maintenance-redesign.md`

## Goal

Remove the whole-knowledge-base "god-job" crunch. The patrol lenses shipped in steps 1–5
(verify, dedupe, split, improve) now cover what scheduled crunch did, so
`trigger_scheduled_crunch` and its `crunch_*` job types are retired per the redesign §4/§8.
`refresh_pull_requests` is unchanged. Source-change-sync must keep working.

## Decisions (settled in brainstorming)

1. **Rename the shared plan vocabulary** to a neutral `Maintenance*` family rather than keeping
   crunch names. Half-retiring (deleting the feature but keeping `CrunchPlan`/`crunch_plan` as the
   source-sync plan shape) would leave misleading dead terminology.
2. **Forward drop migration** — add `0031_drop_crunch.sql`; leave `0010_crunch.sql` untouched
   (the repo only uses forward migrations).
3. **Rename the web section to Schedules** — the `/crunch` page is the only UI for editing
   scheduled-task crons, so it is repurposed (not deleted) into an honest scheduled-tasks manager.

## What is removed (the scheduled-crunch flow)

- **Job types & schemas** (`packages/jobs/src`): `crunch_knowledge_base`,
  `trigger_scheduled_crunch`, `publish_crunch` — type-union entries (`types.ts`), catalog entries
  (`catalog.ts`), and their input/output schemas (`schemas.ts`):
  `crunchKnowledgeBaseInput/OutputSchema`, `triggerScheduledCrunchInput/OutputSchema`,
  `publishCrunchInput/OutputSchema`.
- **API feature**: `apps/api/src/features/crunch/**` (routes, service, schema, tests) and its
  `/crunch` mount in `app.ts`.
- **Stores**: `crunch-store.ts`, `postgres-crunch-store.ts` (+ tests), `CRUNCH_STORE` in
  `platform/stores.ts`, `crunchRuns` wiring in `context.ts` and `test-support/context.ts`,
  the `trigger_scheduled_crunch` reference in `reset-stores.test.ts`.
- **Scheduling**: crunch-schedule build/keys in `jobs/schedule-reconciler.ts`. The generic
  scheduled-task reconciliation stays.
- **Job completion**: `attachCrunchPlanFromCompletedJob` + `recordCrunchPublicationFromCompletedJob`
  dispatch in `features/jobs/service.ts`.
- **Watcher**: `trigger_scheduled_crunch` support + `triggerScheduledCrunch` (`maintenance.ts`);
  `triggerScheduledCrunch` / `crunchExecutionContext` / `CrunchExecutionContext` (`http-client.ts`);
  the `crunch_knowledge_base` case (`job-prompts.ts`); the `publish_crunch` path in
  `runners/publication.ts` (`buildCrunchPullRequestBody`, crunch branch derivation, local
  `changesetFromPlan` mirror if it becomes orphaned).
- **Prompt**: the `crunch-knowledge-base` entry in `packages/prompts/src/catalog.ts`. This drops
  the prompt catalog from 18 → 17, so the exact-count assertions in `apps/api/src/app.test.ts`
  and the prompt/jobs catalog tests update accordingly.
- **Cron utils test**: the InMemoryCrunchStore portion of `apps/api/src/crunch.test.ts`; the cron
  function tests move to a non-crunch home if they are the only coverage (see "Preserved").

## What is preserved and renamed (source-sync entanglement)

The crunch "plan" vocabulary is shared with source-change-sync and must survive:

- Core `CrunchPlan` → `MaintenancePlan`, `CrunchOperation` → `MaintenanceOperation`, and the
  file-write type they reference → `MaintenanceFileWrite` (in `packages/core/src/index.ts`).
- `crunchOperationSchema` → `maintenanceOperationSchema` (`packages/jobs/src/schemas.ts`).
- The `expectedOutput: "crunch_plan"` literal → `"maintenance_plan"`. **Every** occurrence of the
  `"crunch_plan"` string is renamed in lockstep — source-sync emits it
  (`syncSourceChangesGeneratePlanInput/OutputSchema`) and a consumer parses/branches on it.
- `changesetFromPlan` moves out of the deleted `features/crunch/service.ts` into
  `features/source-sync/` (its sole remaining API consumer; the watcher keeps its own copy).
- `syncSourceChangesGeneratePlan*` schema names keep their source-sync identity; only the shared
  `Maintenance*` types/schema/literal they depend on are renamed. `orchestration.test.ts` and
  `source-sync/service.ts` retarget to the new names. Source-sync tests stay green.

**Preserved untouched:** `isValidCron` / `nextCronTime` in `@magpie/core` — used by the surviving
schedule editor and by `features/scheduled-tasks/routes.ts`.

## Database

New forward migration `packages/db/migrations/0031_drop_crunch.sql` dropping `crunch_runs` and
`crunch_settings`. `0010_crunch.sql` is left as-is. Destructive on existing databases (crunch run
history is discarded), which is acceptable because the feature is retired.

## Web

`CrunchPanel` → `SchedulesPanel`:

- **Keep**: the scheduled-tasks table (`scheduledTasks`, grouped by type/flow), the inline cron
  editor with `CRON_PRESETS` and `isValidCron` validation, `onRunTask`/`onSaveTask`.
- **Drop**: flow-crunch `settings` rows, the `runs` / `CrunchRunCard` recent-runs section, and the
  `onPublish` / `onRun` / `onSaveSchedule` props. Update the section heading/hint copy to describe
  scheduled tasks rather than crunch.
- **Routing & nav**: `app/crunch/page.tsx` → `app/schedules/page.tsx`; `sections.ts` entry
  `crunch`/`/crunch`/`"Crunch"`/glyph `Cr` → `schedules`/`/schedules`/`"Schedules"`/glyph `Sc`;
  `ConsoleSection` union updates. `ConsoleProvider` drops `crunchRuns`/`crunchSettings`/`runCrunch`/
  `saveCrunchSchedule`/`publishCrunchRun` and their `/crunch/*` polling, keeps
  `scheduledTasks`/`runScheduledTask`/`saveScheduledTask`.

## Dead-code gate

`knip` runs in STRICT mode (`npm run deadcode`). Removing crunch consumers will expose
newly-orphaned exports (store factories, publication helpers, removed schema exports). Fix by
de-exporting or fully deleting the orphaned symbols — never by relaxing the knip config.

## Testing strategy (inline TDD, RED first)

Drive each removal/rename with a failing assertion first where one naturally exists, watch it fail,
then make it green:

- Catalog/type counts: `packages/jobs` and `packages/prompts` catalog tests assert the reduced set.
- `app.test.ts`: `/crunch` route returns `not_found`; prompt count 18 → 17.
- `schedule-reconciler.test.ts`: no crunch schedules built; generic task schedules unaffected.
- Source-sync (`orchestration.test.ts` + service tests): green under the renamed `Maintenance*`
  vocabulary — this is the regression guard for the rename.
- Watcher focused tests: `maintenance.test.ts` no longer supports `trigger_scheduled_crunch`;
  the fakes drop the removed API methods.
- Web: section list / routing reflects `schedules`, not `crunch`.

**Pre-PR gates:** `npm test -w @magpie/jobs`, `npm test -w @magpie/prompts`, full API suite
(`node --import tsx --test "apps/api/src/**/*.test.ts"`), watcher focused tests,
`npm run typecheck`, `npm run deadcode` — all clean.

## Docs

Mark step 6 done in `docs/maintenance-redesign.md` and update the superpowers progress memory.
