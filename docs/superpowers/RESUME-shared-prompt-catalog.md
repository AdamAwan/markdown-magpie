# Resume prompt — shared prompt catalog feature

Paste the block below into Claude Code tomorrow to pick this up. Everything it
needs is on disk (git history + the plan + the SDD ledger); no memory of the
prior session is required.

---

```
Resume the "shared prompt catalog" feature. We're mid-way through executing it
with subagent-driven development. Do NOT start over or re-plan.

Branch: feat/shared-prompt-catalog  (currently checked out)
Spec:   docs/superpowers/specs/2026-06-17-shared-prompt-catalog-design.md
Plan:   docs/superpowers/plans/2026-06-17-shared-prompt-catalog.md
Ledger: .git/sdd/progress.md   (cat "$(git rev-parse --git-path sdd)/progress.md")

STATE (verify with `git log --oneline main..HEAD` before trusting this):
- Tasks 1-6 are COMPLETE, reviewed clean, and committed on feat/shared-prompt-catalog
  (HEAD a7bed93). That covers: the new @magpie/prompts package + buildJobPrompt,
  and wiring of the watcher, retrieval, and the API direct services, plus the
  GET /api/prompts endpoint.
- Task 7 (web "Prompts" console section) is COMMITTED BUT NOT MERGED. It lives on
  worktree branch `worktree-agent-aaa84fc5aeac8a8b8` (commit dc898b6), checked out
  at .claude/worktrees/agent-aaa84fc5aeac8a8b8. Its code-review had not returned a
  confirmed verdict when we paused — treat it as un-reviewed.

GOTCHA: per-package `npm run typecheck -w <pkg>` fails with a PRE-EXISTING TS6059
for any package importing another @magpie/* package (also affects retrieval/api/
watcher on main). The real type-check gate is the ROOT `npm run typecheck`
(tsconfig.check.json). Per-package `build` is fine.

DO THIS, IN ORDER:
1. Review the Task 7 web diff (git diff 676852a..dc898b6) for spec compliance +
   quality. The implementer self-reported `npm run typecheck -w @magpie/web` PASSED;
   its `npm run build -w @magpie/web` failed ONLY because Turbopack couldn't resolve
   `next` from the worktree path (env limitation, not a code bug). Key risk to check:
   the refresh() Promise.all destructuring length matches its array length after the
   added /prompts fetch.
2. If approved, merge the worktree branch into feat/shared-prompt-catalog:
   `git merge --no-ff worktree-agent-aaa84fc5aeac8a8b8` (web files are disjoint from
   everything else, so this should be clean). Then remove the worktree:
   `git worktree remove .claude/worktrees/agent-aaa84fc5aeac8a8b8`.
3. Verify the web build NOW works in the main checkout: `npm run build -w @magpie/web`.
4. Execute Task 8 (final integration + docs) from the plan: root `npm run build`,
   `npm test`, root `npm run typecheck` (all must pass), then add the README
   "AI prompts" subsection described in Task 8, and commit.
5. Run a final whole-branch code review (superpowers:requesting-code-review) over
   `git merge-base main HEAD`..HEAD. Triage the deferred Minor findings below.
6. Run the app to demo the new Prompts page (use the run-magpie skill): start
   Postgres + API + Web, open the console, click the "Prompts" nav item, confirm the
   8 prompts render with their instruction text, and screenshot it. I (the user)
   specifically asked to see this page working.
7. Finish with superpowers:finishing-a-development-branch.

DEFERRED MINOR FINDINGS (from per-task reviews — triage in the final review, fix if
cheap):
- packages/prompts/src/catalog.test.ts: no test pinning the promptCatalog id ORDER
  (the plan calls the order fixed). Consider adding one.
- apps/watcher/src/main.ts:17: @magpie/prompts import sits after the local
  ./job-prompts.js import (external-after-local); spec-mandated placement, cosmetic.
```

---

## For the human (not part of the prompt)

The 8 catalogued prompts (single source of truth in `packages/prompts/src/catalog.ts`):
`answer-question-queue`, `answer-question-direct`, `summarize-gap`,
`draft-markdown-proposal`, `crunch-knowledge-base`, `gap-clustering`, `generic-job`,
`job-runner-system`. `crunch` and `draft` were consolidated onto the richer (watcher)
wording across both queue and direct modes — that wording change is intentional. The
two `answer_question` variants were deliberately kept separate (different output
contracts); unifying them is explicitly out of scope for this feature.
