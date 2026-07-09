# Claim Provenance Phase 2 — Verify Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The verify patrol stops re-deriving document support from scratch: it receives the claims→sources map recorded by merged proposals (`citedClaims`) and checks each cited claim against its cited location first, flagging claims whose cited support changed or vanished. Claims with no provenance fall back to today's full re-derivation.

**Architecture:** The proposals table is the machine-facing provenance index (phase 1 wrote the events). A store query fetches merged proposals for a document path (including changeset entries); a pure fold function turns that event sequence into the current advisory claim set, dropping claims whose section anchor no longer exists in the document (staleness guard — a dropped claim re-derives rather than producing a false "support changed" verdict). The patrol service threads the folded claims into the `verify_document` job input; the watcher's prompt assembly renders non-`sources` input keys automatically, so no watcher code changes — only the contract and the prompt text.

**Tech Stack:** TypeScript ESM/NodeNext, node:test, zod, custom SQL migrator.

**Spec:** `docs/superpowers/specs/2026-07-08-claim-provenance-design.md`. **Depends on phase 1** (`2026-07-09-claim-provenance-capture.md`) being merged. Branch: `claude/claim-provenance-verify` (main is PR-protected — never push main). Issue: #214.

## Global Constraints

- Same repo non-negotiables as phase 1 (queue-only, no `unknown` casts, `.js` import extensions, validate as you go, commit/push often, per-workspace test commands).
- Migrations: append-only; next free prefix is **0050** at time of writing — re-check before creating.
- `citedClaims` is **advisory input**: the verify agent still explores the source checkouts; absent/empty `citedClaims` must leave behaviour byte-identical to today. The `verify_gap_closure` safety property (#150 — infra failure retries, never a false verdict) is untouched: this plan changes what verify is *told*, not how its failures are handled.
- Broker gotcha applies to job **inputs** read back by the API too — but here the input is constructed API-side and consumed watcher-side, so the zod input schema is the single contract to extend.
- The reuse cache (`verifyDocumentReuseKey`) must incorporate the cited claims — otherwise a provenance change after a merge would reuse a stale verify verdict.

---

### Task 1: Store query — merged proposals for a document path

**Files:**
- Create: `packages/db/migrations/0050_proposals_merged_target_path_idx.sql`
- Modify: `apps/api/src/stores/proposal-store.ts` (interface `ProposalStore` lines 32–61 + `InMemoryProposalStore`)
- Modify: `apps/api/src/stores/postgres-proposal-store.ts`
- Test: `apps/api/src/stores/proposal-store.test.ts`, `apps/api/src/stores/postgres-proposal-store.test.ts`

**Interfaces:**
- Produces (used by Task 2's caller in the patrol service):

```ts
// Merged proposals whose primary target or changeset touches `path`, oldest
// merge first (event order). The provenance event stream for a document.
listMergedByTargetPath(path: string, limit: number): Promise<Proposal[]>;
```

- [ ] **Step 1: Migration** — a partial index so the per-document event query doesn't scan all proposals:

```sql
-- Phase-2 claim provenance (#214): verify reads a document's provenance
-- event stream = merged proposals for that path. Partial index keeps the
-- lookup cheap; changeset matches are rarer and filtered in the query.
CREATE INDEX IF NOT EXISTS proposals_merged_target_path_idx
  ON proposals (target_path, merged_at)
  WHERE status = 'merged';
```

Run the migration-order guard test — PASS.

- [ ] **Step 2: Failing store tests**

In-memory: three proposals — merged targeting `docs/a.md` (early `mergedAt`), merged targeting `docs/a.md` (later), merged targeting `docs/b.md`, plus a non-merged `docs/a.md` draft. `listMergedByTargetPath("docs/a.md", 10)` returns exactly the two merged `a.md` rows, oldest-merge first. Add a changeset case: a merged proposal with `targetPath: "docs/c.md"` whose `changeset` contains `{ path: "docs/a.md", content: "…" }` IS returned for `docs/a.md`.

Postgres: mirror the primary-path and changeset cases inside the existing gated `describe` (line 26), reusing its lifecycle helpers.

- [ ] **Step 3: Verify failure**, then **Step 4: Implement**

Postgres:

```sql
SELECT * FROM proposals
WHERE status = 'merged'
  AND (
    target_path = $1
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(changeset) AS entry
      WHERE entry->>'path' = $1
    )
  )
ORDER BY merged_at ASC NULLS LAST
LIMIT $2
```

(`changeset` is nullable — `jsonb_array_elements` on NULL inside `EXISTS` yields no rows, which is the desired semantics; confirm with the test rather than assuming, and guard with `changeset IS NOT NULL AND` if the planner complains.) In-memory: filter + sort by `mergedAt`.

- [ ] **Step 5: Validate and commit**

```bash
npm test -w @magpie/api && npm run test:db
git add packages/db/migrations/0050_proposals_merged_target_path_idx.sql apps/api/src/stores/
git commit -m "feat(store): query merged proposals by document path (migration 0050) (#214)"
git push -u origin claude/claim-provenance-verify
```

---

### Task 2: Pure provenance fold (`provenance.ts`)

**Files:**
- Create: `apps/api/src/features/proposals/provenance.ts`
- Test: `apps/api/src/features/proposals/provenance.test.ts`

**Interfaces:**
- Consumes: `Proposal[]` (from Task 1), current document content.
- Produces (used by Task 4):

```ts
// Folds a document's provenance event stream (merged proposals, oldest first)
// into the current advisory claim set. Later events supersede earlier ones per
// (anchor ?? claim) key. Claims whose anchor names a section heading that no
// longer exists in `currentContent` are DROPPED — a stale anchor must fall
// back to full re-derivation, never risk a false "cited support changed"
// verdict. Events with no provenance contribute nothing (pre-feature merges,
// human-edit gaps): the fold is advisory by design.
export function foldProvenanceEvents(events: Proposal[], currentContent: string): ProvenanceClaim[];
```

- [ ] **Step 1: Failing tests** — cover:
  1. Single event → its claims returned (anchors present in content).
  2. Two events, same anchor → later event's claim wins; different anchors → both survive.
  3. A claim whose anchor has no matching heading in `currentContent` is dropped; a claim with **no** anchor is kept (nothing to check).
  4. Events with `provenance: undefined` are skipped without error.
  5. Deterministic output order (event order, then within-event order).

- [ ] **Step 2: Verify failure**, then **Step 3: Implement**

Anchor existence check: reuse the **same** heading→anchor slugging the indexer uses — the sectioniser in `packages/markdown` produces `Citation.anchor`, so locate that helper (grep `anchor` in `packages/markdown/src/`) and call it over the parsed document's headings. Do **not** hand-roll a second slug rule; two implementations WILL drift. If the helper isn't exported, export it from `@magpie/markdown` (and consume it — knip flags dead exports).

- [ ] **Step 4: Run** — `npm test -w @magpie/api` PASS.

- [ ] **Step 5: Commit** — `feat(api): provenance event fold with anchor staleness guard (#214)`; push.

---

### Task 3: Jobs contract — `citedClaims` on the verify input

**Files:**
- Modify: `packages/core/src/index.ts` (`VerifyDocumentJobInput`, lines 686–690)
- Modify: `packages/jobs/src/schemas.ts` (`verifyDocumentInputSchema`, lines 368–373)
- Test: `packages/jobs/src/schemas.test.ts`

- [ ] **Step 1: Failing test** — `verifyDocumentInputSchema` accepts and round-trips `citedClaims: ProvenanceClaim[]`; stays optional.

- [ ] **Step 2: Implement**

```ts
export const verifyDocumentInputSchema = z.object({
  provider: providerSchema,
  path: z.string(),
  content: z.string(),
  sources: z.array(sourceDescriptorSchema),
  // #214 phase 2: advisory per-claim provenance folded from the document's
  // merged proposals. The agent checks these against their cited locations
  // first; claims not listed here are re-derived from scratch as before.
  citedClaims: z.array(provenanceClaimSchema).optional()
}) satisfies z.ZodType<ProviderInput<CoreVerifyDocumentJobInput>>;
```

Mirror on the core interface. Note: `buildSourceGroundedPrompt` (`apps/watcher/src/job-prompts.ts:113–143`) strips only `sources` from the rendered input (`omitInputKeys(job.input, ["sources"])`, line 141), so `citedClaims` reaches the agentic prompt automatically — **no watcher change**.

- [ ] **Step 3: Validate and commit** — `npm test -w @magpie/jobs && npm run typecheck`; commit `feat(jobs): citedClaims on the verify_document contract (#214)`; push.

---

### Task 4: Patrol wiring — populate `citedClaims`

**Files:**
- Modify: `apps/api/src/features/patrol/service.ts` (`defaultVerifyDocument` lines 100–125, `verifyDocumentReuseKey` lines 79–85)
- Test: `apps/api/src/features/patrol/service.test.ts` (match its existing fixture/DI style — `defaultVerifyDocument` is injected as `VerifyDocumentFn`, so the patrol-level tests fake it; the new tests target `defaultVerifyDocument` itself with a stubbed `runJobToCompletion` if the file's idiom allows, otherwise test via the job store)

**Interfaces:**
- Consumes: Task 1 query + Task 2 fold.

- [ ] **Step 1: Failing tests**
  1. With two merged proposals for the doc path carrying provenance, the created `verify_document` job input contains the folded `citedClaims`.
  2. With no merged proposals (or none carrying provenance), the input has `citedClaims: undefined` — byte-identical to today.
  3. Two calls with identical `path`/`sources` but different folded claims produce **different** reuse keys.

- [ ] **Step 2: Implement**

In `defaultVerifyDocument` (before building the input at 101–106):

```ts
const events = await ctx.stores.proposals.listMergedByTargetPath(input.path, 50);
const citedClaims = foldProvenanceEvents(events, input.content);
```

Pass `citedClaims: citedClaims.length > 0 ? citedClaims : undefined` in the job input. Extend `verifyDocumentReuseKey` with a stable hash of the folded claims (reuse the same hashing helper `hashSourceDescriptors` uses — locate it and follow its pattern; empty claims must hash to the legacy key shape OR change the key format uniformly — either is fine, reuse is per-tick anyway).

The limit 50 is a cap, not pagination — `log()`-equivalent: if `events.length === 50`, `logger.warn` that older events were ignored (silent truncation would read as full coverage).

- [ ] **Step 3: Run** — `npm test -w @magpie/api` PASS.

- [ ] **Step 4: Commit** — `feat(patrol): feed folded claim provenance into verify_document (#214)`; push.

---

### Task 5: Prompt extension — cited-first verification

**Files:**
- Modify: `packages/prompts/src/catalog.ts` (`VERIFY_DOCUMENT`, lines 345–380)
- Test: `packages/prompts/src/catalog.test.ts`

- [ ] **Step 1: Failing test** — `verify-document` instructions mention `citedClaims` and distinguish the two reason kinds.

- [ ] **Step 2: Implement** — add to the Rules block (keeping the conservative contract intact):

```
- The input may include "citedClaims": claims previously published with the source locations that grounded them. Check each cited claim FIRST against its cited location(s). If the cited file no longer exists or no longer supports the claim, flag it with a reason starting "cited support changed:" naming the cited path. A cited claim whose support still holds needs no further work. Claims NOT in citedClaims are verified by exploring the sources as usual.
- citedClaims is advisory: if it contradicts what you find in the sources, trust the sources.
```

- [ ] **Step 3: Validate and commit** — `npm test -w @magpie/prompts`; commit `feat(prompts): verify checks cited provenance first (#214)`; push.

---

### Task 6: Documentation + full sweep

- [ ] Update `docs/ai-jobs.md` (verify_document input) and the spec's phase-2 status. Full validation: `npm run build && npm run typecheck && npm run lint && npm test && npm run test:db`. Commit `docs: claim provenance phase 2 (#214)`; push.

## Done when

- A doc with merged-proposal provenance gets `citedClaims` in its verify job input (visible in the Schedules UI job payload); a doc without gets today's exact input.
- Stale anchors demonstrably fall back (fold unit test) rather than reaching the agent.
- Reuse cache busts on provenance change; all suites green including `test:db` (migration 0050).
