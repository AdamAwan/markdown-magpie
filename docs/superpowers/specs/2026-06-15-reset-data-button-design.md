# Reset Data Button — Design

Date: 2026-06-15

## Goal

Add a **Reset data** button to the Config page so a presenter can return the app
to its fresh-from-`.env` state between demos. The reset removes everything a user
can create or change through the app, then rebuilds the knowledge bases from the
configured `.env` sources so the app is immediately demo-ready.

## What "reset" means

Reset == the state produced by a fresh boot from `.env` **plus** re-indexing the
configured knowledge sources (the same step `scripts/run-cat-demo.ps1` performs
after boot). Concretely it:

1. Clears all user/app-generated persisted state:
   - `answer_citations`, `questions`
   - `proposals`
   - `gap_clusters`
   - `ai_jobs`
   - indexed knowledge: `document_sections`, `documents`, `repositories`
2. Clears the in-memory knowledge index.
3. Resets the runtime AI config (execution mode / provider) back to the
   `.env`-derived initial values via `createInitialRuntimeConfig()`.
4. Re-syncs the configured git checkouts and re-indexes every indexable
   configured knowledge source/destination from `.env`.

After reset the app holds: no questions, no proposals, no gaps, no jobs, runtime
config at its `.env` defaults, and the knowledge bases freshly indexed.

## Non-goals

- No authentication / authorization on the endpoint. This is a demo aid; it will
  be documented as **not for production** use.
- No partial / selective reset. It is all-or-nothing.
- No change to existing startup behavior (startup still does sync + hydrate only;
  it does not begin auto-indexing).

## Architecture

### Store-level reset (clean, follows the repository pattern)

Rather than running raw `TRUNCATE` from the HTTP handler and bypassing the store
abstraction, each store gains a `reset()` method. Both the Postgres and in-memory
implementations implement it, so tests and the in-memory backend behave the same.

- `QuestionLogStore.reset()` — clears `answer_citations` then `questions`
  (FK order).
- `ProposalStore.reset()` — clears `proposals`, then `gap_clusters`. `proposals`
  references `gap_clusters.id` via `gap_cluster_id`, so proposals are cleared
  first. (`gap_clusters` currently has no writer in the app, but is cleared here
  so the reset stays correct if the gap-clustering loop starts populating it.)
- `AiJobQueue.reset()` — clears `ai_jobs`.
- Knowledge store (`KnowledgePersistence`) gains `reset()` — clears
  `document_sections`, `documents`, `repositories` (FK order).

Postgres implementations run `DELETE`/`TRUNCATE ... CASCADE` inside a single
transaction per store. In-memory implementations clear their maps/arrays.

### In-memory index reset

`InMemoryKnowledgeIndex` gains a `reset()` method that clears its private
`documents`, `sections`, and `repositories` maps. This avoids reassigning the
`const knowledgeIndex` binding in `main.ts`.

### Reusable re-seed function

Extract a `seedConfiguredKnowledge()` helper in `main.ts` that:

1. Calls `syncConfiguredGitCheckouts()`.
2. Iterates the indexable configured sources/destinations and calls
   `knowledgeIndex.indexLocalRepository(...)` for each (the same path
   `handleIndexRepository` uses).
3. Triggers background embedding (`embedSectionsInBackground()`), as the index
   handler already does.

This mirrors the documented demo flow (boot → index) and is called by the reset
handler. (Startup is left unchanged for now to avoid altering boot semantics.)

### Endpoint: `POST /api/admin/reset`

Handler `handleResetData`:

1. `await Promise.all` / sequential calls to each store `reset()`.
2. `knowledgeIndex.reset()`.
3. `runtimeConfig = createInitialRuntimeConfig()`.
4. `await seedConfiguredKnowledge()`.
5. Returns `200` with a summary: counts of repositories/documents/sections
   re-indexed (from `knowledgeIndex.getStats()`), so the UI can confirm.

On failure, returns `500` with `{ error, message }` consistent with existing
error handling.

## Frontend — `ConfigPanel` (`apps/web/src/app/page.tsx`)

- New section in the config panel titled e.g. "Demo controls" with a destructive
  **Reset data** button.
- Click toggles an inline confirm state (Confirm / Cancel) — matching the app's
  existing in-component UI patterns rather than `window.confirm`. Confirm copy:
  "This deletes all questions, proposals, gaps and jobs, resets AI config, and
  re-indexes the knowledge bases from configuration. Continue?"
- On confirm → `apiPost("/admin/reset")`, button shows a busy/disabled state.
- On success → show a brief success message including the re-index summary, and
  refresh the panel's config (re-fetch `/config`) so the reset runtime config is
  reflected.
- On error → show the error message.

## Data flow

```
Reset data (confirm)
  → POST /api/admin/reset
      → questionLogs.reset()  (+ answer_citations)
      → proposals.reset()     (+ gap_clusters)
      → aiJobs.reset()
      → knowledgeStore.reset()
      → knowledgeIndex.reset()
      → runtimeConfig = createInitialRuntimeConfig()
      → seedConfiguredKnowledge()  (sync checkouts → index configured sources → embed)
  → 200 { repositoryCount, documentCount, sectionCount }
  → UI shows success + re-fetches /config
```

## Error handling

- Store/index failures bubble up to the existing top-level `route` try/catch
  (returns `500 internal_error`); the handler adds a clearer message where useful.
- If re-indexing a source fails (e.g. a missing checkout), the handler reports the
  failure in the response but does not leave the app half-cleared — clearing
  always completes before re-seeding begins, so a re-seed failure still yields a
  clean (empty) but recoverable state.

## Testing

- Backend (`node:test`, in-memory stores):
  - `reset()` on each in-memory store clears its data.
  - `InMemoryKnowledgeIndex.reset()` empties stats to zero.
  - A handler-level / integration test (where feasible with the existing harness)
    that after seeding data + reset, the stores are empty and the index reflects
    re-seeded configured sources. If full HTTP wiring is impractical in a unit
    test, test the composed reset logic at the store/index level.
- Frontend: manual verification via the running app (button → confirm → success);
  no new frontend test framework is introduced.

## Documentation

- `docs/api.md`: document `POST /api/admin/reset` (request: none; response:
  re-index summary) with a clear **demo-only, unauthenticated** warning.
- Note the feature in any relevant demo docs if a natural spot exists.

## Files touched (anticipated)

- `apps/api/src/main.ts` — route, `handleResetData`, `seedConfiguredKnowledge`,
  runtime-config reset.
- `apps/api/src/question-log-store.ts` + `postgres-question-log-store.ts` +
  in-memory impl — `reset()`.
- `apps/api/src/proposal-store.ts` + `postgres-proposal-store.ts` + in-memory —
  `reset()`.
- `apps/api/src/postgres-ai-job-queue.ts` (+ queue interface / in-memory) —
  `reset()`.
- `apps/api/src/postgres-knowledge-store.ts` (+ `KnowledgePersistence` interface /
  in-memory) — `reset()`.
- `apps/api/src/knowledge-index.ts` — `reset()`.
- `apps/web/src/app/page.tsx` — `ConfigPanel` button + confirm + call.
- `docs/api.md` — endpoint docs.
- New/updated `*.test.ts` for store and index resets.
