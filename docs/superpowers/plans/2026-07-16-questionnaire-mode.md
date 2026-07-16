# Questionnaire Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explicit questionnaire mode — bulk question batches with verbatim answer reuse
gated by KB-derived freshness checks — per
`docs/superpowers/specs/2026-07-16-questionnaire-mode-design.md`.

**Architecture:** Two migrations (per-section `content_changed_at`; questionnaire tables),
a Postgres questionnaire store, a feature module (`apps/api/src/features/questionnaires/`)
holding the match/reuse-check/drip logic, completion+failure hooks in the jobs service, and
a console section. Reuses `answer_question` wholesale — no new job type, no watcher change.

**Tech Stack:** TypeScript ESM/NodeNext, Hono, Zod, pg/pgvector, node:test, Next.js +
Emotion (web).

## Global Constraints

- Relative imports carry explicit `.js` extensions (ESM/NodeNext).
- Never cast through `unknown`/`any`; no hacky workarounds.
- Migrations are append-only, numbered `0054`/`0055` (next free after 0053), applied by
  `scripts/migrate.mjs` (see write-a-migration skill).
- Validate as you go: `npm run build && npm run typecheck && npm run lint && npm test`
  after each task; commit after each task.
- Postgres-backed tests are gated by `RUN_PG_INTEGRATION` and run via `npm run test:db`
  (needs `DOCKER_HOST` on this machine — see memory).
- Web tests run via bash: `cd apps/web && npm test` under Git Bash.
- Config knobs: `QUESTIONNAIRE_MATCH_THRESHOLD` (default `0.84`),
  `QUESTIONNAIRE_MAX_INFLIGHT` (default `3`) — added to `loadConfig` in
  `apps/api/src/platform/config.ts`, read off `ctx.settings`, never `process.env`.
- Section content hash expression is `md5(heading || '\x1f' || content)` computed in SQL —
  the SAME expression at snapshot time and check time (single store method, no drift).

---

### Task 1: `content_changed_at` on document_sections

**Files:**
- Create: `packages/db/migrations/0054_section_content_changed_at.sql`
- Modify: `apps/api/src/stores/postgres-knowledge-store.ts` (`upsertSections` INSERT/ON
  CONFLICT; add `sectionFingerprints` method)
- Test: `apps/api/src/stores/postgres-knowledge-store.integration.test.ts` (or the
  existing integration test file for this store — colocate with whatever exists)

**Interfaces:**
- Produces: `PostgresKnowledgeStore.sectionFingerprints(sectionIds: string[]): Promise<SectionFingerprint[]>`
  where `SectionFingerprint = { sectionId: string; contentHash: string; contentChangedAt: string /* ISO */ }`
  (missing ids are simply absent from the result — callers treat absence as "changed").

- [ ] **Step 1: Migration**

```sql
-- 0054: Per-section content-change tracking for questionnaire answer reuse.
-- content_changed_at moves ONLY when a section's (heading, content) actually
-- changes — the same byte-identical condition that decides embedding
-- carry-forward in upsertSections. Backfill to now() is deliberately
-- conservative: content predating the column briefly reads as "just changed",
-- suppressing (never corrupting) reuse until the first re-answer.
ALTER TABLE document_sections
  ADD COLUMN content_changed_at timestamptz NOT NULL DEFAULT now();
```

- [ ] **Step 2: Failing integration test** — index a two-section doc, capture both
  `content_changed_at` values, re-index with section 2's content edited; assert section 1's
  timestamp is unchanged and section 2's advanced. Also assert `sectionFingerprints` returns
  both rows with an md5 hash, and omits an unknown id.

- [ ] **Step 3: Implement** — in `upsertSections`, add `content_changed_at` to the INSERT
  columns (value `now()`), and to the ON CONFLICT SET list:

```sql
content_changed_at = CASE
  WHEN document_sections.content = EXCLUDED.content
   AND document_sections.heading = EXCLUDED.heading
  THEN document_sections.content_changed_at
  ELSE now()
END
```

  Add `sectionFingerprints`:

```ts
async sectionFingerprints(sectionIds: string[]): Promise<SectionFingerprint[]> {
  if (sectionIds.length === 0) return [];
  const result = await this.pool.query<{ id: string; hash: string; changed_at: Date }>(
    `SELECT id, md5(heading || E'\\x1f' || content) AS hash, content_changed_at AS changed_at
       FROM document_sections WHERE id = ANY($1::text[])`,
    [sectionIds]
  );
  return result.rows.map((row) => ({
    sectionId: row.id, contentHash: row.hash, contentChangedAt: row.changed_at.toISOString()
  }));
}
```

- [ ] **Step 4: Run** `npm run db:migrate` against the test harness via `npm run test:db`
  (filter to this store's tests); expect PASS.
- [ ] **Step 5: Commit** `feat(db): track per-section content_changed_at`

---

### Task 2: Questionnaire tables + core types + purpose union

**Files:**
- Create: `packages/db/migrations/0055_questionnaires.sql` (tables exactly as in the spec's
  Data model section; plus, if `questions.purpose` carries a CHECK constraint from its
  original migration — verify by grepping `purpose` in `packages/db/migrations/` — extend
  it to admit `'questionnaire'`)
- Modify: `packages/core/src/index.ts` (purpose unions at lines ~242/251 become
  `"live" | "verification" | "questionnaire"`; add `Questionnaire`, `QuestionnaireItem`,
  `QuestionnaireItemCitation`, `ChangeReason` interfaces)
- Modify: `apps/api/src/platform/answer-question.ts` (`recordAnswerQuestionLog` purpose
  param type widens to match)
- Modify: `apps/api/src/stores/postgres-question-log-store.ts` — gap candidacy keeps
  questionnaire questions **in**: lines 37, 87, 851 `q.purpose = 'live'` →
  `q.purpose IN ('live','questionnaire')`. Questions list + count (lines 645, 657) stay
  `= 'live'` (worksheet is the surface for items). `replaceGaps` (line 233) untouched.
  Insights (postgres-insights-store.ts:678) stays `= 'live'`.
- Test: extend `apps/api/src/stores/postgres-question-log-store.test.ts` — a
  `purpose: "questionnaire"` log is gap-candidate but absent from `list()`.

**Interfaces:**
- Produces (packages/core):

```ts
export type QuestionnaireItemStatus = "pending" | "answering" | "answered" | "unanswerable" | "approved";
export type QuestionnaireItemOutcome = "reused" | "fresh" | "changed";
export interface ChangeReason {
  kind: "section_changed" | "new_content" | "section_missing";
  sectionId: string; path: string; heading: string; changedAt?: string;
}
export interface QuestionnaireItem {
  id: string; questionnaireId: string; position: number; question: string;
  status: QuestionnaireItemStatus; outcome?: QuestionnaireItemOutcome;
  answer?: string; answeredAt?: string; questionLogId?: string;
  reusedFromItemId?: string; changeReason?: ChangeReason; approvedAt?: string;
  citations: QuestionnaireItemCitation[]; staleAtApproval?: boolean;
}
export interface QuestionnaireItemCitation {
  sectionId: string; contentHash: string; path: string; heading: string; excerpt: string;
}
export interface Questionnaire {
  id: string; name: string; flowId: string; status: "open" | "completed" | "archived";
  createdAt: string; items: QuestionnaireItem[];
}
```

- [ ] Steps: failing store test → migration + types → gating edits → `npm run test:db`
  filtered to question-log store → PASS → commit
  `feat(core,db): questionnaire tables + questionnaire question purpose`.

Note: `questionnaire_items` also carries `question_embedding vector(1536)`,
`embedding_model text`, and `stale_at_approval boolean NOT NULL DEFAULT false` (the spec's
`stale-at-approval` flag) — include them in 0055.

---

### Task 3: Postgres questionnaire store

**Files:**
- Create: `apps/api/src/stores/questionnaire-store.ts` (interface),
  `apps/api/src/stores/postgres-questionnaire-store.ts`
- Modify: `apps/api/src/platform/stores.ts` + `apps/api/src/context.ts` to construct and
  expose `ctx.stores.questionnaires` (follow how seed plans' store is wired)
- Test: `apps/api/src/stores/postgres-questionnaire-store.integration.test.ts`

**Interfaces (produces):**

```ts
export interface QuestionnaireStore {
  create(input: { name: string; flowId: string; questions: string[] }): Promise<Questionnaire>;
  get(id: string): Promise<Questionnaire | undefined>;
  list(): Promise<QuestionnaireSummary[]>; // {id,name,flowId,status,createdAt,counts:{total,reused,answered,pending,unanswerable,approved}}
  setItemEmbeddings(items: { itemId: string; embedding: number[]; model: string }[]): Promise<void>;
  // nearest approved prior item in the flow above `threshold`, matching `model`:
  matchApproved(flowId: string, embedding: number[], model: string, threshold: number):
    Promise<{ item: QuestionnaireItem; similarity: number } | undefined>;
  markReused(itemId: string, from: { itemId: string; answer: string; answeredAt: string }): Promise<void>;
  markChanged(itemId: string, reason: ChangeReason): Promise<void>; // stays pending for the drip; outcome=changed
  markAnswering(itemId: string, questionLogId: string): Promise<void>;
  completeItem(questionLogId: string, result: { answer: string; answeredAt: string;
    citations: QuestionnaireItemCitation[]; unanswerable: boolean }): Promise<QuestionnaireItem | undefined>;
  failItem(questionLogId: string, error: string): Promise<QuestionnaireItem | undefined>; // → unanswerable
  itemByQuestionLogId(questionLogId: string): Promise<QuestionnaireItem | undefined>;
  nextPending(questionnaireId: string): Promise<QuestionnaireItem | undefined>; // lowest position, status=pending
  countAnswering(questionnaireId: string): Promise<number>;
  approveItem(itemId: string, citations: QuestionnaireItemCitation[], staleAtApproval: boolean): Promise<void>;
  listReusedUnapproved(questionnaireId: string): Promise<QuestionnaireItem[]>;
}
```

- [ ] Steps: failing integration tests per method group (create/get/list; match with a
  seeded vector; drip counters; approve) → implement with batched inserts following
  `postgres-question-log-store.ts` conventions → `npm run test:db` filtered → PASS →
  commit `feat(api): questionnaire store`.

Matching SQL (pgvector cosine distance, similarity = 1 − distance):

```sql
SELECT qi.*, 1 - (qi.question_embedding <=> $3::vector) AS similarity
FROM questionnaire_items qi
JOIN questionnaires qn ON qn.id = qi.questionnaire_id
WHERE qn.flow_id = $1 AND qi.status = 'approved'
  AND qi.embedding_model = $2 AND qi.question_embedding IS NOT NULL
ORDER BY qi.question_embedding <=> $3::vector
LIMIT 1
```

(then apply the threshold in TS so the "no match" path is explicit).

---

### Task 4: Reuse check + service (match, drip, approval, export)

**Files:**
- Create: `apps/api/src/features/questionnaires/service.ts`,
  `apps/api/src/features/questionnaires/reuse-check.ts`,
  `apps/api/src/features/questionnaires/export.ts`
- Test: colocated `.test.ts` for each (unit; fake stores per existing service-test pattern)

**Interfaces:**
- Consumes: `retrieve(ctx, { question, flowId, limit })` (features/retrieve/service.js),
  `ctx.providers.embedding` (`EmbeddingProvider | undefined`),
  `recordAnswerQuestionLog(ctx, q, "questionnaire")` + `buildAnswerQuestionInput(ctx, …)`
  (platform/answer-question.js), `ctx.jobs.create("answer_question", input)`,
  `ctx.stores.questionnaires` (Task 3), `sectionFingerprints` (Task 1),
  `assertAiCapacity` — mirror how features/ask/service.ts guards enqueues.
- Produces:

```ts
createQuestionnaire(ctx, input: { name: string; flowId: string; questions: string[] }):
  Promise<{ ok: true; questionnaire: Questionnaire } | { ok: false; code: "flow_not_found" | "empty_questionnaire" }>
getQuestionnaire(ctx, id): Promise<Questionnaire | undefined>
listQuestionnaires(ctx): Promise<QuestionnaireSummary[]>
approveItem(ctx, questionnaireId, itemId): Promise<{ ok: boolean; code?: string }>
approveReused(ctx, questionnaireId): Promise<{ approved: number }>
topUpDrip(ctx, questionnaireId): Promise<void>
handleQuestionnaireAnswerCompletion(ctx, job, output): Promise<void> // wired in Task 5
handleQuestionnaireAnswerFailure(ctx, job): Promise<void>
exportQuestionnaire(q: Questionnaire, format: "md" | "csv"): string
```

**Reuse check (reuse-check.ts) — the core algorithm:**

```ts
const NEWCOMER_TOP_K = 8;

export async function checkReuse(
  ctx: AppContext,
  prior: QuestionnaireItem,          // matched approved item (has citations + answeredAt)
  question: string,
  flowId: string
): Promise<{ reuse: true } | { reuse: false; reason: ChangeReason }> {
  // Check 1: every snapshotted citation still exists with identical content.
  const current = await ctx.stores.knowledge.sectionFingerprints(
    prior.citations.map((c) => c.sectionId)
  );
  const byId = new Map(current.map((f) => [f.sectionId, f]));
  for (const cited of prior.citations) {
    const now = byId.get(cited.sectionId);
    if (!now) return { reuse: false, reason: { kind: "section_missing", sectionId: cited.sectionId, path: cited.path, heading: cited.heading } };
    if (now.contentHash !== cited.contentHash)
      return { reuse: false, reason: { kind: "section_changed", sectionId: cited.sectionId, path: cited.path, heading: cited.heading, changedAt: now.contentChangedAt } };
  }
  // Check 2: nothing relevant is newer than the answer (original generation time).
  const retrieved = await retrieve(ctx, { question, flowId, limit: NEWCOMER_TOP_K });
  if (!retrieved.ok) return { reuse: false, reason: { kind: "new_content", sectionId: "", path: "", heading: "" } };
  const hits = await ctx.stores.knowledge.sectionFingerprints(retrieved.sections.map((s) => s.sectionId));
  const answeredAt = prior.answeredAt!;
  for (const hit of hits) {
    if (hit.contentChangedAt > answeredAt) {
      const section = retrieved.sections.find((s) => s.sectionId === hit.sectionId)!;
      return { reuse: false, reason: { kind: "new_content", sectionId: hit.sectionId, path: section.path, heading: section.heading, changedAt: hit.contentChangedAt } };
    }
  }
  return { reuse: true };
}
```

(`prior.citations` are the approval-time snapshot, so cited-but-since-reindexed sections
compare against the durable hash, not `answer_citations`.)

**Creation flow:** validate flow exists → store.create → if `ctx.providers.embedding`
present, `embedAll` questions (reuse the helper pattern from gap-reconciler) +
`setItemEmbeddings` → per item: `matchApproved`; on match run `checkReuse`; reuse →
`markReused` (copying the prior's `answeredAt` forward per spec) else `markChanged` →
`topUpDrip`. No embedding provider → skip matching entirely (all fresh), mirroring
keyword-only degradation.

**Drip:** `topUpDrip` loops while `countAnswering(id) < ctx.settings.questionnaireMaxInflight`
and `nextPending` yields an item: record log (purpose `questionnaire`), build input with
`requestedFlowId: flow.id`, `ctx.jobs.create("answer_question", input)`, `markAnswering`.
Derived, not timer-held: called from creation, from every completion/failure hook, and from
`getQuestionnaire` (worksheet read) so a restart can never wedge a questionnaire.

**Completion hook:** `handleQuestionnaireAnswerCompletion(ctx, job, output)` — guard
`job.type === "answer_question"` and `input.questionLogId` resolves via
`itemByQuestionLogId`; map output → `completeItem` with
`unanswerable = output.citations.length === 0 || output.confidence === "low" || output.confidence === "unknown"`,
citations mapped through `sectionFingerprints` for hashes; then `topUpDrip`. Failure hook
mirrors via `failItem`.

**Approval:** fresh/changed items snapshot from the item's citations re-fingerprinted now
(`staleAtApproval = true` if any cited id vanished); reused items copy the reused-from
snapshot verbatim. Approving also backfills the item embedding if creation-time embedding
was skipped.

**Export:** markdown = `## Q\n\nA` pairs; csv = `position,question,answer,status` with
RFC-4180 quoting. Pure function, unit-tested.

- [ ] Steps: failing unit tests for reuse-check (both checks, each failure kind,
  missing-section, newcomer-newer, all-pass), drip top-up (fills to cap, restart
  derivation), unanswerable mapping, export quoting → implement → `npm test -w @magpie/api`
  (or the api workspace name) → PASS → commit `feat(api): questionnaire service + reuse check`.

---

### Task 5: Routes, app mount, config knobs, jobs-service hooks

**Files:**
- Create: `apps/api/src/features/questionnaires/routes.ts`, `schema.ts`
- Modify: `apps/api/src/app.ts` (mount at `/api/questionnaires`),
  `apps/api/src/platform/config.ts` (two knobs),
  `apps/api/src/features/jobs/service.ts` (call completion hook next to
  `updateQuestionLogFromCompletedJob` at line ~317; failure hook in `failJob`)
- Test: `apps/api/src/features/questionnaires/routes.test.ts` (follow seed routes.test.ts
  harness), config test if config has one.

**Routes (per spec API surface):**

```ts
app.post("/", requireScopes("ask:knowledge"), rateLimit(ctx, "trigger"), zValidator("json", createSchema, …), async (c) => {
  const body = c.req.valid("json");
  if (!ctx.knowledgeConfig.flows.some((f) => f.id === body.flowId)) throw new HttpError(404, "flow_not_found");
  assertCan(ctx, c, "ask", body.flowId);
  const outcome = await createQuestionnaire(ctx, body);
  if (!outcome.ok) throw new HttpError(outcome.code === "flow_not_found" ? 404 : 400, outcome.code);
  return c.json({ questionnaire: outcome.questionnaire }, 201);
});
app.get("/", requireScopes("read:knowledge"), …);           // filter list to flows the principal can read
app.get("/:id", requireScopes("read:knowledge"), …);        // 404 on cross-flow per convention (assertCan read)
app.post("/:id/items/:itemId/approve", requireScopes("manage:knowledge"), …); // assertCan manage
app.post("/:id/approve-reused", requireScopes("manage:knowledge"), …);
app.get("/:id/export", requireScopes("read:knowledge"), …); // ?format=md|csv, text response
```

`createSchema = z.object({ name: z.string().min(1), flowId: z.string().min(1), questions: z.array(z.string().min(1)).min(1).max(500) })`.

- [ ] Steps: failing route tests (201 create, 404 unknown flow, worksheet get, approve,
  export content-type) → implement + mount + knobs + hooks → run api workspace tests →
  full `npm run build && npm run typecheck && npm run lint && npm test` → commit
  `feat(api): questionnaire routes + completion hooks`.

---

### Task 6: Web console section

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`ConsoleSection` union + `Questionnaire` view
  types), `apps/web/src/lib/sections.ts`
  (`{ section: "questionnaires", path: "/questionnaires", glyph: "Qn", label: "Questionnaires", group: 1 }`),
  `apps/web/src/components/ConsoleProvider.tsx` (handlers `listQuestionnaires`,
  `getQuestionnaire`, `createQuestionnaire`, `approveQuestionnaireItem`,
  `approveReusedItems` via `apiGet/apiPost` — paths without `/api` prefix)
- Create: `apps/web/src/app/questionnaires/page.tsx` (thin `"use client"` shell:
  `Workbench > Surface > Surface.Header/Body`, delegates to panel),
  `apps/web/src/components/QuestionnairesPanel.tsx`
- Test: `apps/web/src/components/QuestionnairesPanel.test.tsx` (renderMarkup assertions)

**Panel behaviour:** single component, list + selected detail (the `/seed` `SeedPanel`
model — no nested route). Create form: name input, flow `Select`, questions `Textarea`
(one per line, split + trim + drop empties client-side). Worksheet: item rows with
`Badge` per status/outcome (`reused`→success tone, `changed`→warning, `unanswerable`→danger,
`fresh`→neutral), answer text, citations, and for `changed` items the prior answer +
`change_reason` rendered ("re-answered: *Data retention* changed 2026-06-03"). Approve
button per item + "Approve all reused". Export buttons link to the export endpoint via
`resolveApiUrl`. While any item is `pending|answering`, poll `getQuestionnaire` on a 5s
`window.setInterval` inside `useEffect`, with the handler stabilized via `useRef` +
`useCallback` exactly as `SeedPanel.tsx:199-246` does (ConsoleProvider handlers are
re-created every poll — copying the ref pattern is load-bearing, not stylistic).
Styling: Emotion `styled` with `({ theme }) => ({...})` token access, transient `$props`;
no CSS files.

- [ ] Steps: failing panel test (renders create form; renders item badges from fixture
  data) → implement types/sections/provider/page/panel → `bash -c "cd apps/web && npm test"`
  → PASS → commit `feat(web): questionnaires console section`.

---

### Task 7: Docs + validation sweep

**Files:**
- Create: `docs/questionnaires.md` (feature reference: lifecycle, reuse rule, purpose
  semantics, API surface, knobs)
- Modify: `docs/api.md` (routes), `docs/question-logging.md` (purpose union + gap-candidacy
  table), `.claude/skills/magpie-orientation/SKILL.md` (§2 pipeline entry + web sections
  list count), `README.md` if it enumerates console sections
- [ ] Steps: write docs → full validation (`npm run build`, `typecheck`, `lint`,
  `format:check`, `deadcode`, `npm test`, `npm run test:db`) → fix fallout (knip is STRICT:
  de-export anything unused rather than relaxing config) → commit
  `docs: questionnaire mode reference + orientation update`.

---

### Task 8: PR + live verification

- [ ] Push branch, open PR against `main` titled
  `feat: questionnaire mode — verbatim answer reuse with KB-derived freshness` with a body
  summarising the spec, linking it, ending with the Claude Code attribution footer.
- [ ] Launch the local stack via the **run-magpie** skill (Postgres → migrate → API →
  Watcher ×2 → Web with local `.env` overrides) and drive `/questionnaires`: create a small
  questionnaire against the local flow, watch the drip answer it, approve items, create an
  overlapping second questionnaire, verify a `reused` badge appears. Screenshot for the PR.

## Self-review notes

- Spec coverage: create/match/reuse/drip/review/approve/export ✅ (Tasks 3–6); migrations +
  carry-forward ✅ (1–2); purpose semantics ✅ (2); error handling — job failure → failItem
  hook (4–5), restart-derived drip (4), stale-at-approval (3–4), no-embedding degradation
  (4) ✅; testing pyramid ✅ (unit in 4, integration in 1–3, e2e-by-hand in 8 — the
  scripted `e2e:jobs` extension from the spec is deferred to a follow-up if the manual
  drive in Task 8 is green, to keep the PR reviewable).
- Type names consistent: `QuestionnaireItemCitation`, `ChangeReason`, `sectionFingerprints`
  used identically in Tasks 1/3/4.
