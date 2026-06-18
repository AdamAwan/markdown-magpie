# Task 7 Report: Add read-only "Prompts" section to the web console

## What Was Changed

### `apps/web/src/app/page.tsx`
- Added `PromptSummary` interface (id, title, description, usedBy, outputShape, instructions) immediately above `ConsoleSection`.
- Extended `ConsoleSection` union to include `"prompts"`.
- Added `const [prompts, setPrompts] = useState<PromptSummary[]>([])` after `scheduledTasks` state.
- Extended `Promise.all` destructuring to include `promptsResult`; added `apiGet<{ prompts: PromptSummary[] }>("/prompts")` as the final array entry.
- Added `setPrompts(promptsResult.prompts)` after `setConfig(configResult)`.
- Added `<NavButton>` for Prompts after Crunch and before Data Flow.
- Added section render block after Crunch block and before Data Flow block.
- Added `PromptsPanel` component immediately after `AttentionPanel`.
- Added `sectionTitle` and `sectionSubtitle` entries for `"prompts"` before the fallback returns.

### `apps/web/src/app/styles.css`
- Appended all prompt-related CSS classes.

## Verification

- `npm run typecheck -w @magpie/web` — PASSED (exit 0, no errors)
- `npm run build -w @magpie/web` — FAILED (Turbopack cannot locate next/package.json from inside the worktree path — known worktree env issue described in brief)

## Self-Review

- Nav button placement: after Crunch, before Data Flow — correct.
- No double-wrap: PromptsPanel returns inner div/p; render block adds the outer section.
- sectionTitle/sectionSubtitle prompts entries are before the fallback returns.
- No @magpie/prompts import; PromptSummary declared locally.
- No casts through unknown.

## Concerns

The `npm run build` failure is purely a worktree path resolution issue with Turbopack (cannot find next/package.json from inside the symlinked worktree directory). This is not a code defect. The typecheck gate passes cleanly. The main repo build should succeed.
