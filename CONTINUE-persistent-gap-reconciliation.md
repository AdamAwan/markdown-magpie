# Continue: Persistent Gap Reconciliation

Paste the prompt below into Claude Code to resume. Work is on branch
`worktree-persistent-gap-reconciliation` (worktree at
`.claude/worktrees/persistent-gap-reconciliation`).

## Status

Tasks 1–12 of `docs/superpowers/plans/2026-06-18-persistent-gap-reconciliation.md`
are done, committed, and verified: `npm run lint` (0 errors),
`npm run typecheck` (clean), and `npm run test:db` (all green) all pass on this
branch. Remaining: **Tasks 13, 14, 15, 16.**

Notable deviations already made (also recorded in the plan's "Execution Progress"
section): a plan test-data bug in Task 9 was corrected; the prompts-catalog tests
(`packages/prompts/src/catalog.test.ts`) and `apps/api/src/app.test.ts` prompt
counts were updated for the two new prompts (9→11); `@magpie/git` gained a `test`
script + `src/test-support.ts`; the question-log store gained `getGapCatalogRevision`,
`gapIdsForSummary`, and `gapDetailsForIds`.

---

## Prompt to run tomorrow

> Resume executing `docs/superpowers/plans/2026-06-18-persistent-gap-reconciliation.md`
> from **Task 13**. Tasks 1–12 are already complete, committed, and green on the
> branch `worktree-persistent-gap-reconciliation` — do not redo them; read the
> plan's "Execution Progress (updated 2026-06-19)" section first to see what was
> done and the deviations made. Work in the existing worktree at
> `.claude/worktrees/persistent-gap-reconciliation` (do not create a new one).
> Continue task-by-task with the same TDD discipline (write the failing test, see
> it fail, implement, see it pass, commit per task). Run `npm run typecheck` and
> the relevant `npm run test`/`npm run test:db` after each task.
>
> Specifically:
> - **Task 13** — `draftFromCluster` service fn + `POST /clusters/:id/proposal` route.
> - **Task 14** — fold `pull-request-refresh` into `gaps-to-pull-requests` (cron
>   `*/10 * * * *`, `runGapReconciler`). **Stop and ask me** whether the reconciler
>   runs **inline** (single-instance, the plan's default) or as a **claimed AI job**
>   (multi-instance) before implementing — this is the open design seam.
> - **Task 15** — backfill one cluster per existing proposal; prefer the store-based
>   `backfillGapClusters` over the SQL file, test-first, then wire into `bootstrap()`.
> - **Task 16** — update `docs/api.md`, then run the full sweep: `npm run lint`,
>   `npm run typecheck`, `npm run test`, `npm run test:db`, and `npm run deadcode`
>   (knip). Expect knip to flag `clusterGapCandidates`/`requestGapClusters` (in
>   `features/gaps/service.ts`) and `processGapsIntoPullRequests`/`refreshPullRequests`
>   (in `scheduling/task-registry.ts`) once Task 14 removes their last callers —
>   delete the genuinely-dead code it reports.
>
> When all tasks pass, use the superpowers:finishing-a-development-branch skill to
> wrap up (verify tests, present merge/PR options).
