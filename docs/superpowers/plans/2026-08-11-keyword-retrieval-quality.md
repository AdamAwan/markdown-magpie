# Keyword-Retrieval Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make keyword-only retrieval a genuinely usable first-class mode — recall that survives natural-language questions, ranking that degrades gracefully instead of returning nothing, and gap records that distinguish "we could not find it" from "it is not there".

**Architecture:** Rebuild `document_sections.search_tsv` as a weighted vector (heading / heading-path / file path / content) maintained by a trigger. Match on OR'd lexemes so partial matches survive, rank with `ts_rank_cd` and boost sections that also satisfy the strict query. Replace the single absolute relevance floor with a two-part absolute-plus-relative floor. Stamp gaps with the retrieval mode that produced them and keep lexical-only gaps out of automatic proposal generation.

**Tech Stack:** TypeScript (ESM/NodeNext), Node ≥22.13, Postgres full-text search (stock — no extensions), `node:test`, npm workspaces.

## Global Constraints

- **No extra model calls.** No query-time expansion, no index-time alias generation. Every ranking change is Postgres-side or in-process.
- **No new Postgres extensions.** No `pg_trgm`, no custom text-search configurations or synonym dictionaries. Stock FTS only.
- **Never cast through `unknown` or `any`** to silence types (CLAUDE.md).
- **Validate as you go:** `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` per task — do not batch.
- **Run `npm run verify` before pushing.** It gates on `format:check`, `lint`, `deadcode` (knip, STRICT — fix unused exports by de-exporting, never by relaxing config), `typecheck`.
- **Workspace tests run as `npm test -w <pkg>`**, never root-cwd `node --test`, or `@magpie/*` resolves to stale `dist`.
- **This worktree needs its own `npm install`** before anything builds.
- **Migrations are append-only, no rollback**, named `NNNN_name.sql`, unique numeric prefix. Next free prefix is `0063`.
- **Integration tests are gated by `RUN_PG_INTEGRATION=1`** and need `DOCKER_HOST` set to the Docker Desktop Linux-engine pipe on Windows.
- **Update `docs/retrieval.md` alongside the code** — it is a living as-built spec.

## Deviations from the spec

Two, both discovered during planning. Flagged rather than applied silently:

1. **Spec §1 said** that if `array_to_string` is not IMMUTABLE, denormalise a `heading_path_text` column written by the application. `array_to_string(anyarray, text)` is indeed STABLE, so the generated-column route is closed — but a **BEFORE INSERT/UPDATE trigger** is strictly better than the denormalised column: it has no immutability requirement, needs no redundant column, and preserves migration 0034's explicit "stays in sync without application-side maintenance" property. Verified safe: `scripts/migrate.mjs` sends each file as one `client.query`, so `$$`-quoted plpgsql bodies survive.

2. **Spec §4 said** the `answer_question` job input carries `retrievalMode`. It does not need to: the watcher learns the mode from every `/api/retrieve` response, which is fresher than a value snapshotted at enqueue time and cannot go stale mid-job. And the API stamps `question_gaps.retrieval_mode` from its own config at completion, so nothing needs to round-trip through the job payload at all. The job schema is left untouched.

## File Structure

**Migrations (create):**
- `packages/db/migrations/0063_weighted_section_fts.sql` — trigger-maintained weighted `search_tsv` + backfill + GIN index.
- `packages/db/migrations/0064_gap_retrieval_mode.sql` — `question_gaps.retrieval_mode`.

**Modify:**
- `apps/api/src/stores/postgres-knowledge-store.ts` — `searchByKeyword` query; delete `normaliseRank`.
- `apps/api/src/stores/knowledge-index.ts` — `SectionKeywordSearch` unchanged; `keywordRankInMemory` + `scoreSection` gain the two new fields and weights.
- `apps/api/src/features/retrieve/service.ts` — two-part floor; return `retrievalMode` + `candidateCount`.
- `apps/api/src/features/retrieve/routes.ts` — surface the two new response fields.
- `apps/api/src/stores/postgres-question-log-store.ts` — stamp `retrieval_mode` on retrieval-derived gaps; exclude lexical-only gaps from candidacy.
- `apps/watcher/src/job-prompts.ts` — keyword-mode framing for empty searches.
- `apps/watcher/src/runners/generative.ts` — carry the mode from the retrieve response into the prompt.
- `docs/retrieval.md` — R14/R16/R17 and the constants table.

**Tests (create/modify):**
- `apps/api/src/stores/postgres-knowledge-store.integration.test.ts` (create)
- `apps/api/src/stores/knowledge-index.test.ts` (modify)
- `apps/api/src/features/retrieve/service.test.ts` (modify)

---

### Task 1: Weighted, trigger-maintained `search_tsv`

Migration 0034 built `search_tsv` from `heading || ' ' || content`, unweighted — so `heading_path` (`Billing > Refunds`) and `path` (`billing/refunds.md`) are unsearchable. This task fixes the index only; ranking still uses the old query and stays green.

**Files:**
- Create: `packages/db/migrations/0063_weighted_section_fts.sql`
- Create: `apps/api/src/stores/postgres-knowledge-store.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `document_sections.search_tsv` as a weighted `tsvector` — weight `A` = `heading`, `B` = `heading_path` and `path`, `C` = `content`. Same column name and type as before, so `searchByKeyword` keeps compiling unchanged.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/stores/postgres-knowledge-store.integration.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";

// DB-backed tests for the keyword-search SQL. Gated by RUN_PG_INTEGRATION so the
// default unit run stays database-free (see the writing-magpie-tests skill).
const runIntegration = process.env.RUN_PG_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/markdown_magpie";

// Inserts one repository + document + section and returns the section id.
// Each caller gets a unique repository id so parallel tests cannot collide.
async function seedSection(
  pool: pg.Pool,
  section: { heading: string; headingPath: string[]; path: string; content: string }
): Promise<{ sectionId: string; repositoryId: string }> {
  const repositoryId = `kw-${randomUUID()}`;
  const documentId = `${repositoryId}:${section.path}`;
  const sectionId = `${documentId}#0`;
  await pool.query(
    "INSERT INTO repositories (id, name, default_branch, local_path, provider) VALUES ($1, $1, 'main', '/tmp', 'local')",
    [repositoryId]
  );
  await pool.query("INSERT INTO documents (id, repository_id, path, content) VALUES ($1, $2, $3, $4)", [
    documentId,
    repositoryId,
    section.path,
    section.content
  ]);
  await pool.query(
    `INSERT INTO document_sections (id, document_id, path, heading, heading_path, anchor, content, ordinal)
     VALUES ($1, $2, $3, $4, $5, 'a', $6, 0)`,
    [sectionId, documentId, section.path, section.heading, section.headingPath, section.content]
  );
  return { sectionId, repositoryId };
}

test("search_tsv indexes heading_path and path, weighted", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());

  const { sectionId, repositoryId } = await seedSection(pool, {
    heading: "Annual plans",
    headingPath: ["Billing", "Refunds"],
    path: "billing/cancellation-policy.md",
    content: "Customers on yearly agreements receive credit."
  });
  t.after(async () => {
    await pool.query("DELETE FROM repositories WHERE id = $1", [repositoryId]);
  });

  // "refunds" appears ONLY in heading_path; "cancellation" ONLY in the file path.
  const found = await pool.query<{ id: string }>(
    `SELECT id FROM document_sections
     WHERE id = $1 AND search_tsv @@ websearch_to_tsquery('english', 'refunds cancellation')`,
    [sectionId]
  );
  assert.equal(found.rowCount, 1, "heading_path and path must be searchable");

  // The heading term must outrank a body term: weight A beats weight C.
  const ranks = await pool.query<{ heading_rank: string; body_rank: string }>(
    `SELECT ts_rank_cd('{0.1,0.3,0.6,1.0}'::float4[], search_tsv, websearch_to_tsquery('english','annual')) AS heading_rank,
            ts_rank_cd('{0.1,0.3,0.6,1.0}'::float4[], search_tsv, websearch_to_tsquery('english','credit'))  AS body_rank
     FROM document_sections WHERE id = $1`,
    [sectionId]
  );
  assert.ok(
    Number(ranks.rows[0].heading_rank) > Number(ranks.rows[0].body_rank),
    "a heading match must outrank a body match"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
RUN_PG_INTEGRATION=1 npm test -w apps/api -- --test-name-pattern="search_tsv indexes"
```

Expected: FAIL on the first assertion — `rowCount` is `0`, because `refunds` and `cancellation` appear only in `heading_path` / `path`, neither of which is indexed today.

If the run **skips** instead, Postgres is not reachable. Start it and re-run `npm run migrate` (see the `run-magpie` skill; on Windows set `DOCKER_HOST` to the Docker Desktop Linux-engine pipe).

- [ ] **Step 3: Write the migration**

Create `packages/db/migrations/0063_weighted_section_fts.sql`:

```sql
-- Weighted full-text index for keyword retrieval (supersedes 0034).
--
-- 0034 indexed `heading || ' ' || content`, unweighted, so a section's ancestor
-- headings and its file path were unsearchable and a heading hit ranked no
-- higher than a body hit. This rebuilds the vector with four weighted fields:
--   A  heading             the section's own title
--   B  heading_path        ancestor headings ("Billing > Refunds")
--   B  path                the file path, punctuation flattened to spaces
--   C  content             body text
--
-- Maintained by a BEFORE trigger rather than GENERATED ALWAYS, because
-- array_to_string(anyarray, text) is STABLE, not IMMUTABLE, and a stored
-- generated column requires an IMMUTABLE expression. A trigger keeps 0034's
-- "no application-side maintenance" property without a hand-declared IMMUTABLE
-- wrapper (which would be an assertion we cannot enforce, and interacts badly
-- with dump/restore ordering).
--
-- A generated column's expression cannot be altered in place, so the column is
-- dropped and recreated. That rewrites document_sections; acceptable at current
-- corpus sizes, and the whole migration runs in one transaction.

DROP INDEX IF EXISTS document_sections_search_tsv_gin;
ALTER TABLE document_sections DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE document_sections ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION document_sections_search_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
       setweight(to_tsvector('english'::regconfig, coalesce(NEW.heading, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(NEW.heading_path, ' '), '')), 'B')
    -- Flatten path punctuation so "billing/annual-plans.md" tokenises into words.
    || setweight(to_tsvector('english'::regconfig, translate(coalesce(NEW.path, ''), '/-_.', '    ')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Scoped to the source columns on purpose: section rows are also updated to save
-- embeddings, and recomputing the tsvector on every embedding write would be
-- pure waste.
CREATE TRIGGER document_sections_search_tsv_trg
  BEFORE INSERT OR UPDATE OF heading, heading_path, path, content
  ON document_sections
  FOR EACH ROW EXECUTE FUNCTION document_sections_search_tsv_refresh();

-- Backfill. Touching `content` is what fires the trigger's UPDATE OF list;
-- assigning search_tsv directly would not.
UPDATE document_sections SET content = content;

CREATE INDEX document_sections_search_tsv_gin
  ON document_sections USING gin (search_tsv);
```

- [ ] **Step 4: Apply the migration and re-run the test**

```bash
npm run migrate
```

```bash
RUN_PG_INTEGRATION=1 npm test -w apps/api -- --test-name-pattern="search_tsv indexes"
```

Expected: PASS — both assertions.

- [ ] **Step 5: Confirm nothing else regressed**

```bash
npm run build -w apps/api && npm test -w apps/api && npm run typecheck && npm run lint
```

Expected: all green. `searchByKeyword` still uses `websearch_to_tsquery` against the same column name, so no TypeScript changed.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0063_weighted_section_fts.sql apps/api/src/stores/postgres-knowledge-store.integration.test.ts
git commit -m "feat(retrieval): weight section FTS by heading, heading path and file path"
```

---

### Task 2: OR matching with graded ranking

`websearch_to_tsquery` ANDs every lexeme, so `how do we handle refunds for annual subscriptions?` compiles to `handl & refund & annual & subscript` — all four required in one section. This replaces the match condition with OR'd lexemes and lets rank do the grading.

**Files:**
- Modify: `apps/api/src/stores/postgres-knowledge-store.ts` (`searchByKeyword`, and delete `normaliseRank`)
- Modify: `apps/api/src/stores/postgres-knowledge-store.integration.test.ts`

**Interfaces:**
- Consumes: the weighted `search_tsv` from Task 1.
- Produces: `searchByKeyword(query: string, limit: number, repositoryIds?: string[]): Promise<Array<{ id: string; relevance: number }>>` — signature unchanged, but `relevance` is now `ts_rank_cd(..., 32)` (already bounded in `[0,1)`) times a strict-match boost, so it can exceed the old scale. `normaliseRank` no longer exists.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/stores/postgres-knowledge-store.integration.test.ts`:

```typescript
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";

test("partial-question matches survive, whole-question matches outrank them", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());

  const whole = await seedSection(pool, {
    heading: "Refunds on annual subscriptions",
    headingPath: ["Billing"],
    path: "billing/annual.md",
    content: "We refund annual subscriptions pro rata."
  });
  const partial = await seedSection(pool, {
    heading: "Refunds",
    headingPath: ["Billing"],
    path: "billing/refunds.md",
    content: "Refunds are issued to the original payment method."
  });
  t.after(async () => {
    await pool.query("DELETE FROM repositories WHERE id = ANY($1)", [[whole.repositoryId, partial.repositoryId]]);
  });

  const store = new PostgresKnowledgeStore(pool);
  const hits = await store.searchByKeyword("how do we handle refunds for annual subscriptions?", 10, [
    whole.repositoryId,
    partial.repositoryId
  ]);

  const ids = hits.map((hit) => hit.id);
  assert.ok(ids.includes(partial.sectionId), "a section matching only some terms must still be returned");
  assert.equal(ids[0], whole.sectionId, "the section matching the whole question must rank first");
  for (const hit of hits) {
    assert.ok(hit.relevance > 0 && hit.relevance <= 1, `relevance ${hit.relevance} must stay in (0,1]`);
  }
});

test("a stopword-only question returns nothing", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const store = new PostgresKnowledgeStore(pool);
  assert.deepEqual(await store.searchByKeyword("the and of", 10), []);
});
```

Check `PostgresKnowledgeStore`'s constructor signature before writing this — if it takes more than `(pool)` (for example an embedding-model id), pass what it needs.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
RUN_PG_INTEGRATION=1 npm test -w apps/api -- --test-name-pattern="partial-question matches"
```

Expected: FAIL — `ids` is empty or missing `partial.sectionId`, because the strict AND excludes it.

- [ ] **Step 3: Rewrite the query**

In `apps/api/src/stores/postgres-knowledge-store.ts`, replace the body of `searchByKeyword` (keeping the signature and the empty-query guard):

```typescript
  async searchByKeyword(
    query: string,
    limit: number,
    repositoryIds?: string[]
  ): Promise<Array<{ id: string; relevance: number }>> {
    // Empty/stopword-only queries produce an empty tsquery, which matches nothing.
    if (query.trim().length === 0) {
      return [];
    }
    // Matching ORs the question's lexemes so a section that covers part of the
    // question still surfaces; ranking then does the grading, because ts_rank_cd
    // scores a section that matched more of the query higher. The strict
    // websearch_to_tsquery is kept as a multiplier so whole-question matches
    // retain the precedence they had when strict matching was the gate.
    //
    // The OR'd query is built by running the question through to_tsvector and
    // taking its lexemes, which reuses Postgres's own stemming and stopword
    // removal rather than string-munging plainto_tsquery's output. Each lexeme is
    // quote_literal'd so punctuation cannot produce a malformed tsquery. A
    // question with no content lexemes yields an empty tsquery, matching nothing.
    //
    // Normalisation flag 32 is rank/(rank+1), already bounded in [0,1) — which is
    // why there is no application-side rank normalisation any more.
    const repositoryFilter = repositoryIds && repositoryIds.length > 0 ? repositoryIds : null;
    const result = await this.pool.query<{ id: string; relevance: string }>(
      `
        WITH q AS (
          SELECT
            to_tsquery(
              'english',
              coalesce(
                (
                  SELECT string_agg(quote_literal(lexeme), ' | ')
                  FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lexeme
                ),
                ''
              )
            ) AS any_query,
            websearch_to_tsquery('english', $1) AS all_query
        )
        SELECT s.id,
               ts_rank_cd($5::float4[], s.search_tsv, q.any_query, 32)
                 * CASE WHEN s.search_tsv @@ q.all_query THEN $4::float4 ELSE 1.0 END AS relevance
        FROM document_sections s
        JOIN documents d ON d.id = s.document_id
        CROSS JOIN q
        WHERE s.search_tsv @@ q.any_query
          AND ($3::text[] IS NULL OR d.repository_id = ANY($3))
        ORDER BY relevance DESC
        LIMIT $2
      `,
      [query, limit, repositoryFilter, STRICT_MATCH_BOOST, TS_RANK_WEIGHTS]
    );
    return result.rows.map((row) => ({ id: row.id, relevance: Math.min(1, Number(row.relevance)) }));
  }
```

Add the two constants near the top of the file, beside the existing module constants:

```typescript
// ts_rank weight array, ordered {D, C, B, A} — see migration 0063 for what each
// weight labels. Body text (C) is deliberately well below heading (A) and
// heading-path/file-path (B): a term in a heading is far stronger evidence of
// aboutness than the same term buried in prose.
const TS_RANK_WEIGHTS = [0.1, 0.3, 0.6, 1.0];
// Multiplier for sections that satisfy the strict whole-question tsquery, not
// just the OR'd one. Starting value; tuned against docs/golden-eval.md in Task 7.
const STRICT_MATCH_BOOST = 1.5;
```

Then delete the now-unused `normaliseRank` function at the bottom of the file. Leaving it would fail `npm run deadcode`.

The `Math.min(1, ...)` clamp exists because the boost can push a near-1 rank above 1, and `relevance` is contractually `[0,1]` — it is compared against vector cosine similarity in `knowledge-index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
RUN_PG_INTEGRATION=1 npm test -w apps/api
```

Expected: PASS, including the Task 1 tests and the stopword case.

- [ ] **Step 5: Validate**

```bash
npm run build -w apps/api && npm test -w apps/api && npm run typecheck && npm run lint && npm run deadcode
```

Expected: all green. `deadcode` is the check that `normaliseRank` really was removed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/stores/postgres-knowledge-store.ts apps/api/src/stores/postgres-knowledge-store.integration.test.ts
git commit -m "feat(retrieval): match keyword search on OR'd lexemes with graded ranking"
```

---

### Task 3: Two-part relevance floor, and retrieval diagnostics

OR matching admits weak single-term hits, so a purely absolute floor is now the wrong shape. And the caller cannot currently tell "nothing matched" from "everything was filtered out" — which is what makes the watcher treat a lexical miss as evidence of absence.

**Files:**
- Modify: `apps/api/src/features/retrieve/service.ts`
- Modify: `apps/api/src/features/retrieve/routes.ts`
- Modify: `apps/api/src/features/retrieve/service.test.ts`

**Interfaces:**
- Consumes: `searchByKeyword` relevance scale from Task 2; `retrievalMode(config): { mode: "hybrid" | "keyword"; reason: string }` from `apps/api/src/platform/providers.ts`.
- Produces: `RetrieveResult` gains `retrievalMode: "hybrid" | "keyword"` and `candidateCount: number` (matches **before** the floor). `POST /api/retrieve` responds `{ sections, retrievalMode, candidateCount }`. Task 6 consumes both.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/features/retrieve/service.test.ts`, follow the existing fixture style in that file for building `ctx`, and add:

```typescript
test("keeps weak results when they are the best available", async () => {
  // Every candidate is weak. Returning nothing here is the exact failure this
  // work exists to remove, so all three survive.
  const ctx = buildContext([
    { id: "s1", relevance: 0.2 },
    { id: "s2", relevance: 0.18 },
    { id: "s3", relevance: 0.17 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.equal(result.sections.length, 3);
});

test("drops weak results that sit alongside a strong one", async () => {
  const ctx = buildContext([
    { id: "s1", relevance: 0.9 },
    { id: "s2", relevance: 0.2 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.deepEqual(
    result.sections.map((section) => section.sectionId),
    ["s1"]
  );
});

test("reports candidate count before the floor, and the retrieval mode", async () => {
  const ctx = buildContext([
    { id: "s1", relevance: 0.9 },
    { id: "s2", relevance: 0.02 }
  ]);
  const result = await retrieve(ctx, { question: "anything" });
  assert.ok(result.ok);
  assert.equal(result.sections.length, 1);
  assert.equal(result.candidateCount, 2, "candidateCount counts matches before the floor");
  assert.equal(result.retrievalMode, "keyword", "no embedding provider is configured in the fixture");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w apps/api -- --test-name-pattern="weak results|candidate count"
```

Expected: FAIL — the first with 0 sections (all below `MIN_RELEVANCE`), the third with `undefined` for both new fields.

- [ ] **Step 3: Implement the floor and diagnostics**

In `apps/api/src/features/retrieve/service.ts`, replace the `MIN_RELEVANCE` constant and its comment:

```typescript
// Absolute floor: a section this weak is a clear non-match regardless of what
// else scored. Conservative on purpose — it removes noise, not borderline hits.
const MIN_RELEVANCE = 0.15;
// Relative floor: keep sections within this fraction of the best result. OR'd
// keyword matching (see PostgresKnowledgeStore.searchByKeyword) surfaces
// single-term hits that hybrid retrieval never produced, so a strong result now
// implies its weak neighbours are noise.
//
// The two floors do different jobs, which is why both exist. The absolute floor
// alone returns nothing when every candidate is weak — and in keyword mode
// "nothing" is read downstream as evidence the knowledge base does not cover the
// question, which is exactly the false signal this design removes. So the
// relative floor is only allowed to cut when there IS a strong result to be
// relative to: weak-but-best results survive, weak-beside-strong results do not.
const RELATIVE_RELEVANCE_FLOOR = 0.35;
```

Update `RetrieveResult` and `retrieve`:

```typescript
export type RetrieveResult =
  | { ok: true; sections: RetrievedSection[]; retrievalMode: "hybrid" | "keyword"; candidateCount: number }
  | { ok: false; code: "unknown_flow" };
```

```typescript
  const ranked = await ctx.stores.knowledgeIndex.search(request.question, limit, scope.repositoryIds);
  const topRelevance = ranked.length > 0 ? Math.max(...ranked.map(({ relevance }) => relevance)) : 0;
  const relativeFloor = topRelevance * RELATIVE_RELEVANCE_FLOOR;

  return {
    ok: true,
    retrievalMode: retrievalMode(ctx.config.get()).mode,
    // Counted before the floor so the caller can tell "nothing matched" from
    // "matches existed but were filtered" — the distinction the watcher needs to
    // avoid reading a lexical miss as evidence of absence.
    candidateCount: ranked.length,
    sections: ranked
      .filter(({ relevance }) => relevance >= MIN_RELEVANCE && relevance >= relativeFloor)
      .map(({ section, relevance }) => ({
        sectionId: section.id,
        documentId: section.documentId,
        anchor: section.anchor,
        path: section.path,
        heading: section.heading,
        content: section.content,
        relevance
      }))
  };
```

Add `import { retrievalMode } from "../../platform/providers.js";` at the top.

`describeFlowScope` in the same file deliberately does **not** get the floor — its whole purpose is showing the closest content even when weak. Leave it alone.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w apps/api -- --test-name-pattern="weak results|candidate count"
```

Expected: PASS.

- [ ] **Step 5: Surface the fields on the route**

In `apps/api/src/features/retrieve/routes.ts`, change the success response:

```typescript
      return c.json({
        sections: result.sections,
        retrievalMode: result.retrievalMode,
        candidateCount: result.candidateCount
      });
```

- [ ] **Step 6: Validate**

```bash
npm run build -w apps/api && npm test -w apps/api && npm run typecheck && npm run lint
```

Expected: all green. If any other caller of `retrieve()` destructures `RetrieveResult`, the compiler will point at it — added fields are backwards-compatible, so no call site should need changing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/features/retrieve
git commit -m "feat(retrieval): two-part relevance floor and retrieval diagnostics"
```

---

### Task 4: In-memory scorer parity

`keywordRankInMemory` is the fallback when Postgres is unavailable and the path most unit tests exercise. It already ORs terms, but scores only `heading + content` — so after Tasks 1–2 the two paths would rank differently for the same corpus.

**Files:**
- Modify: `apps/api/src/stores/knowledge-index.ts` (`scoreSection`, `KEYWORD_RELEVANCE_SCALE`)
- Modify: `apps/api/src/stores/knowledge-index.test.ts`

**Interfaces:**
- Consumes: the weight ordering established in Task 1 (heading > heading-path/path > content).
- Produces: `scoreSection(section: DocumentSection, terms: string[]): number` — unchanged signature, now scoring four fields.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/stores/knowledge-index.test.ts`, following the existing fixture helpers in that file:

```typescript
test("in-memory keyword ranking scores heading path and file path", async () => {
  const index = new InMemoryKnowledgeIndex();
  await index.indexMarkdownDocuments({
    repositoryId: "repo",
    documents: [
      { path: "billing/refunds.md", content: "# Billing\n\n## Annual plans\n\nCredit is issued pro rata.\n" },
      { path: "other/notes.md", content: "# Other\n\n## Notes\n\nUnrelated prose about credit.\n" }
    ]
  });

  // "refunds" occurs only in the first document's file path.
  const byPath = await index.search("refunds", 5, ["repo"]);
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0].section.path, "billing/refunds.md");

  // "billing" occurs only in the first document's heading path.
  const byHeadingPath = await index.search("billing", 5, ["repo"]);
  assert.equal(byHeadingPath.length, 1);
  assert.equal(byHeadingPath[0].section.path, "billing/refunds.md");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w apps/api -- --test-name-pattern="in-memory keyword ranking scores"
```

Expected: FAIL — `byPath.length` is `0`; neither field is scored.

- [ ] **Step 3: Widen the scorer**

In `apps/api/src/stores/knowledge-index.ts`, replace `scoreSection`:

```typescript
// Per-term field weights, mirroring the tsvector weights in migration 0063 so the
// in-memory fallback and the Postgres path cannot silently rank differently.
// Scaled ×10 relative to the SQL weight array to keep this integer arithmetic.
const HEADING_WEIGHT = 10;
const HEADING_PATH_WEIGHT = 6;
const PATH_WEIGHT = 6;
const CONTENT_WEIGHT = 3;

function scoreSection(section: DocumentSection, terms: string[]): number {
  const heading = section.heading.toLowerCase();
  const headingPath = section.headingPath.join(" ").toLowerCase();
  // Flatten path punctuation so "billing/annual-plans.md" contributes words,
  // matching the translate() in migration 0063.
  const path = section.path.toLowerCase().replace(/[/\-_.]+/g, " ");
  const content = section.content.toLowerCase();

  return terms.reduce((score, term) => {
    let termScore = 0;
    if (heading.includes(term)) {
      termScore += HEADING_WEIGHT;
    }
    if (headingPath.includes(term)) {
      termScore += HEADING_PATH_WEIGHT;
    }
    if (path.includes(term)) {
      termScore += PATH_WEIGHT;
    }
    if (content.includes(term)) {
      termScore += CONTENT_WEIGHT;
    }
    return score + termScore;
  }, 0);
}
```

Update `KEYWORD_RELEVANCE_SCALE` and its comment — the old value of `6` was calibrated to the old 3/1 scoring and would now saturate almost everything to relevance `1`:

```typescript
// Normalises raw keyword scores into [0,1]. Roughly the score of a strong
// two-term hit landing in both the heading and the body under the field weights
// below (2 × (10 + 3)); stronger hits clamp to 1.
const KEYWORD_RELEVANCE_SCALE = 26;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w apps/api -- --test-name-pattern="in-memory keyword ranking scores"
```

Expected: PASS.

- [ ] **Step 5: Validate the whole suite**

```bash
npm run build -w apps/api && npm test -w apps/api && npm run typecheck && npm run lint
```

Expected: all green. Existing `knowledge-index.test.ts` cases that assert exact relevance numbers will have shifted — recompute the expected values from the new weights and scale rather than loosening the assertions to inequalities.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/stores/knowledge-index.ts apps/api/src/stores/knowledge-index.test.ts
git commit -m "feat(retrieval): score heading path and file path in the in-memory scorer"
```

---

### Task 5: Gap provenance and candidacy gate

A gap recorded in keyword mode rests on weaker evidence than one recorded in hybrid mode. This records which mode produced it, and keeps lexical-only gaps out of automatic proposal generation while leaving them fully visible in the console.

**Files:**
- Create: `packages/db/migrations/0064_gap_retrieval_mode.sql`
- Modify: `apps/api/src/stores/postgres-question-log-store.ts`

**Interfaces:**
- Consumes: `retrievalMode(config).mode` from `apps/api/src/platform/providers.ts`.
- Produces: `question_gaps.retrieval_mode text` — `'hybrid'`, `'keyword'`, or NULL (recorded before this change, or not retrieval-derived). `gapIdsForSummary` / `gapIdsForSummaries` exclude `retrieval_mode = 'keyword'`.

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/0064_gap_retrieval_mode.sql`:

```sql
-- Which retrieval mode was active when a gap was recorded.
--
-- In hybrid mode a search that returns nothing is strong evidence of absence:
-- vector search returns nearest neighbours for any query, so empty means nothing
-- close exists. In keyword-only mode it means only that no lexeme matched, which
-- is a far weaker claim. Gap candidacy (gapIdsForSummary) excludes keyword-mode
-- gaps so they never drive unattended proposal generation; they remain fully
-- visible in the console, because in a deployment that will never have an
-- embeddings endpoint, discarding them would switch the gaps subsystem off.
--
-- NULL means either "recorded before this column existed" or "not derived from
-- retrieval" (manual flags, feedback gaps). Both are treated as candidates,
-- preserving existing behaviour.
ALTER TABLE question_gaps
  ADD COLUMN IF NOT EXISTS retrieval_mode text
  CHECK (retrieval_mode IN ('hybrid', 'keyword'));
```

- [ ] **Step 2: Apply it**

```bash
npm run migrate
```

Expected: `Applying 0064_gap_retrieval_mode.sql` then `Database migrations complete`.

- [ ] **Step 3: Write the failing test**

In `apps/api/src/stores/postgres-gap-cluster-store.test.ts` — which already has an `insertGap` helper and the DB harness — add:

```typescript
test("keyword-mode gaps are excluded from gap candidacy", { skip: !runIntegration }, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());

  const questionId = `cand-${randomUUID()}`;
  await pool.query(
    "INSERT INTO questions (id, question, chat_provider, asked_at, purpose) VALUES ($1,'q','mock',now(),'live')",
    [questionId]
  );
  t.after(async () => {
    await pool.query("DELETE FROM questions WHERE id = $1", [questionId]);
  });

  const summary = `gap-${randomUUID()}`;
  await pool.query(
    "INSERT INTO question_gaps (question_id, summary, source, retrieval_mode) VALUES ($1,$2,'auto','keyword')",
    [questionId, summary]
  );

  const store = new PostgresQuestionLogStore(pool);
  assert.deepEqual(await store.gapIdsForSummary(summary), [], "a keyword-mode gap must not be a candidate");

  await pool.query("UPDATE question_gaps SET retrieval_mode = 'hybrid' WHERE summary = $1", [summary]);
  assert.equal((await store.gapIdsForSummary(summary)).length, 1, "a hybrid-mode gap must be a candidate");
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
RUN_PG_INTEGRATION=1 npm test -w apps/api -- --test-name-pattern="excluded from gap candidacy"
```

Expected: FAIL on the first assertion — the keyword gap is returned, because candidacy does not filter on mode yet.

- [ ] **Step 5: Stamp the mode on retrieval-derived gaps**

In `apps/api/src/stores/postgres-question-log-store.ts`, extend `insertGapRows` (around line 1008) to carry the mode:

```typescript
async function insertGapRows(
  client: pg.PoolClient,
  questionId: string,
  gaps: Array<{ summary: string; source: QuestionGapSource; note?: string }>,
  // The retrieval mode active when the answer was produced, for gaps derived from
  // retrieval ('auto' and 'followup'). Manual flags and feedback gaps are not
  // retrieval-derived, so they stay NULL and remain unconditional candidates.
  retrievalMode?: "hybrid" | "keyword"
): Promise<void> {
  if (gaps.length === 0) {
    return;
  }

  await client.query(
    `
      INSERT INTO question_gaps (question_id, summary, source, note, retrieval_mode)
      VALUES ${valuesClause(gaps.length, 5)}
    `,
    gaps.flatMap((gap) => [
      questionId,
      gap.summary,
      gap.source,
      gap.note ?? null,
      gap.source === "auto" || gap.source === "followup" ? (retrievalMode ?? null) : null
    ])
  );
}
```

There are exactly three `insertGapRows` call sites:

| Line | Method | Passes a mode? |
| --- | --- | --- |
| ~187 | `record()` — a fresh answer's gaps | **yes** |
| ~337 | `updateAnswer()` — gaps after an answer is revised | **yes** |
| ~474 | the manual-flag path | no — leave the argument off, so it stays NULL |

The store must not read config itself (it takes a `pg.Pool`, not an `AppContext`). Add an optional `retrievalMode?: "hybrid" | "keyword"` to the **input objects** of `record()` and `updateAnswer()` — the same objects that already carry `chatProvider` and `flowId` — and forward it to `insertGapRows`. Update the corresponding interface in `apps/api/src/stores/question-log-store.ts` (or wherever `QuestionLogStore` is declared) and any in-memory implementation of it.

The callers are the job-completion handler and `recordAnswerQuestionLog`'s siblings, both of which hold `ctx`; they compute the value as `retrievalMode(ctx.config.get()).mode`.

- [ ] **Step 6: Gate candidacy**

In the same file, add the exclusion to **both** `gapIdsForSummary` (~line 43) and `gapIdsForSummaries` (~line 97). In `gapIdsForSummary`, alongside the existing `qg.resolved_at IS NULL` predicates:

```sql
          -- Keyword-mode gaps rest on "no lexeme matched", not "nothing close
          -- exists", so they never drive unattended proposal generation. NULL
          -- (pre-existing, manual, or feedback gaps) stays a candidate.
          AND qg.retrieval_mode IS DISTINCT FROM 'keyword'
```

In `gapIdsForSummaries`, add the same predicate to the `JOIN question_gaps qg ON ...` condition list.

Note `IS DISTINCT FROM` rather than `<> 'keyword'`: the latter is NULL for NULL rows, which would silently drop every legacy gap from candidacy.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
RUN_PG_INTEGRATION=1 npm test -w apps/api
```

Expected: PASS, both assertions and the existing candidacy tests.

- [ ] **Step 8: Validate**

```bash
npm run build -w apps/api && npm test -w apps/api && npm run typecheck && npm run lint
```

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0064_gap_retrieval_mode.sql apps/api/src/stores/postgres-question-log-store.ts apps/api/src/stores/postgres-gap-cluster-store.test.ts
git commit -m "feat(gaps): record retrieval mode and keep lexical-only gaps out of candidacy"
```

---

### Task 6: Tell the answering loop what an empty search means

The loop records queries that returned nothing and feeds them to the model as grounding. In keyword mode that presents a lexical miss as evidence of absence. This makes the framing honest.

**Files:**
- Modify: `apps/watcher/src/http-client.ts` (`WatcherApi.retrieve` return type, and its implementation at ~line 249)
- Modify: `apps/watcher/src/runners/generative.ts` (~line 294–325: `unsatisfiedSearches`, `seed`, `runSearches`)
- Modify: `apps/watcher/src/job-prompts.ts`
- Modify: `apps/watcher/src/job-prompts.test.ts`

**Interfaces:**
- Consumes: `retrievalMode` and `candidateCount` from the `/api/retrieve` response (Task 3).
- Produces:
  - `WatcherApi.retrieve(...)` now resolves to `RetrieveResponse` instead of `RetrievedSection[]`:
    ```typescript
    export interface RetrieveResponse {
      sections: RetrievedSection[];
      retrievalMode: "hybrid" | "keyword";
      candidateCount: number;
    }
    ```
    `http-client.ts` currently destructures `{ sections }` and throws the rest away, so this is where the mode is being lost.
  - `buildEmptySearchNote(queries: string[], retrievalMode: "hybrid" | "keyword"): string`, exported from `job-prompts.ts`.

Changing `retrieve`'s return type touches every call site: the seed retrieval and `runSearches` in `generative.ts`, plus the stubs in `generative.test.ts` and `repair.test.ts`. That churn is the point — it is what makes it impossible to consume retrieval results while ignoring the mode they were produced under.

- [ ] **Step 1: Write the failing test**

In `apps/watcher/src/job-prompts.test.ts`, matching how that file already asserts on built prompt text:

```typescript
test("empty searches are framed as lexical misses in keyword mode", () => {
  const keyword = buildEmptySearchNote(["annual refunds"], "keyword");
  assert.match(keyword, /lexical/i);
  assert.doesNotMatch(keyword, /not covered/i);

  const hybrid = buildEmptySearchNote(["annual refunds"], "hybrid");
  assert.doesNotMatch(hybrid, /lexical/i);
});
```

The helper does not exist yet — `generative.ts` currently only collects query strings into the `unsatisfiedSearches` set (~line 295, populated at ~line 318) and the prose that presents them lives in the prompt catalog. Create `buildEmptySearchNote` in `job-prompts.ts` so the text is testable without running a job, and have `generative.ts` call it with `[...unsatisfiedSearches]`.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -w apps/watcher -- --test-name-pattern="lexical misses"
```

Expected: FAIL — the helper does not exist, or ignores its second argument.

- [ ] **Step 3: Implement the framing**

In `apps/watcher/src/job-prompts.ts`:

```typescript
// How a search that returned nothing should be presented to the model.
//
// In hybrid mode, empty is strong evidence: vector search returns nearest
// neighbours for any query, so nothing came back means nothing close exists.
// In keyword-only mode it means no lexeme matched — the knowledge base may cover
// the topic in different words. Saying so is what stops the model minting
// knowledge gaps out of vocabulary mismatches.
export function buildEmptySearchNote(queries: string[], retrievalMode: "hybrid" | "keyword"): string {
  const list = queries.map((query) => `- ${query}`).join("\n");
  if (retrievalMode === "keyword") {
    return [
      "These searches returned no sections:",
      list,
      "",
      "Semantic search is unavailable in this deployment; these were lexical",
      "keyword searches. No match means no shared wording was found — it is NOT",
      "evidence that the knowledge base lacks the information. Prefer retrying with",
      "different vocabulary over concluding a knowledge gap."
    ].join("\n");
  }
  return ["These searches returned no sections:", list].join("\n");
}
```

In `apps/watcher/src/http-client.ts`, stop discarding the rest of the response:

```typescript
  async retrieve(
    question: string,
    flowId: string | undefined,
    limit: number | undefined,
    signal?: AbortSignal
  ): Promise<RetrieveResponse> {
    const body = await this.post<Partial<RetrieveResponse>>(
      "/api/retrieve",
      {
        question,
        ...(flowId ? { flowId } : {}),
        ...(limit ? { limit } : {})
      },
      signal
    );
    const sections = body.sections ?? [];
    return {
      sections,
      // Default to "hybrid" so an API predating these fields cannot silently
      // switch the watcher into the weaker-evidence framing.
      retrievalMode: body.retrievalMode ?? "hybrid",
      candidateCount: body.candidateCount ?? sections.length
    };
  }
```

In `apps/watcher/src/runners/generative.ts`, update the two call sites (`seed` at ~line 301, and inside `runSearches` at ~line 315) to destructure `sections`, track the mode from the seed response, and pass it into `buildEmptySearchNote` where `unsatisfiedSearches` is rendered into the prompt.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w apps/watcher -- --test-name-pattern="lexical misses"
```

Expected: PASS.

- [ ] **Step 5: Validate**

```bash
npm run build && npm test -w apps/watcher && npm run typecheck && npm run lint
```

Expected: all green. `generative.test.ts` stubs the retrieve callback — if a stub returns a response without `retrievalMode`, the `"hybrid"` default keeps it passing.

- [ ] **Step 6: Commit**

```bash
git add apps/watcher/src
git commit -m "feat(answering): frame empty keyword searches as lexical misses, not absence"
```

---

### Task 7: Tune the constants and update the spec

Three constants were introduced or invalidated by the earlier tasks. This task fixes their values against real eval output and brings `docs/retrieval.md` back in line with the code.

**Files:**
- Modify: `apps/api/src/stores/postgres-knowledge-store.ts` (`STRICT_MATCH_BOOST`)
- Modify: `apps/api/src/features/retrieve/service.ts` (`MIN_RELEVANCE`, `RELATIVE_RELEVANCE_FLOOR`)
- Modify: `docs/retrieval.md`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: no interface changes — values and documentation only.

- [ ] **Step 1: Record the hybrid baseline**

Run the golden eval per `docs/golden-eval.md`, with an embeddings endpoint configured, on `main` (or with these commits stashed). Save the output — this is the regression baseline for hybrid mode.

- [ ] **Step 2: Run the eval on this branch, in both modes**

Run it twice on the branch: once with embeddings configured (hybrid), once with `OPENAI_COMPATIBLE_EMBEDDING_MODEL` unset (keyword). The second run is the number this whole plan exists to move.

- [ ] **Step 3: Tune**

Starting values are `STRICT_MATCH_BOOST = 1.5`, `RELATIVE_RELEVANCE_FLOOR = 0.35`, `MIN_RELEVANCE = 0.15`.

`MIN_RELEVANCE` is the one that most needs re-derivation: it was calibrated against the old `rank/(rank+0.1)` normalisation, which Task 2 replaced with `ts_rank_cd(..., 32)` = `rank/(rank+1)`. The same underlying rank now maps to a **lower** relevance, so carrying `0.15` over unchanged silently tightens the floor.

Adjust one constant at a time and re-run. Hybrid must not regress against the Step 1 baseline; if it does, the constant is wrong — do not gate the floor on retrieval mode to protect the number.

- [ ] **Step 4: Update the living spec**

In `docs/retrieval.md`:
- **R14** — keyword ranking is now OR-matched `ts_rank_cd` over a weighted tsvector with a strict-match boost, not `websearch_to_tsquery` + `ts_rank`.
- **R16** — the floor is two-part (absolute + relative); state explicitly that an empty result in keyword mode is *not* treated as evidence of a knowledge gap.
- **R17** — keyword-only degradation now also stamps `question_gaps.retrieval_mode` and excludes those gaps from candidacy.
- **Key constants** — add `RELATIVE_RELEVANCE_FLOOR` and `STRICT_MATCH_BOOST`, update `MIN_RELEVANCE` to its tuned value, and remove the `normaliseRank` reference if the table carries one.
- **Code map** — add migration `0063` and the trigger function.
- **Provenance** — add `docs/superpowers/specs/2026-08-11-keyword-retrieval-quality-design.md`.

- [ ] **Step 5: Full verification**

```bash
npm run verify && npm test
```

Expected: all green — `format:check`, `lint`, `deadcode`, `typecheck`, and the full unit suite.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src docs/retrieval.md
git commit -m "chore(retrieval): tune keyword-mode constants and refresh the retrieval spec"
```

---

## Verification checklist

Before opening the PR:

- [ ] `npm run verify` passes.
- [ ] `npm test` passes.
- [ ] `RUN_PG_INTEGRATION=1 npm test -w apps/api` passes.
- [ ] Golden eval: hybrid has not regressed against the Step 1 baseline.
- [ ] Golden eval: keyword mode has measurably improved.
- [ ] `docs/retrieval.md` matches the code as built.
- [ ] Manual smoke test via the `run-magpie` skill, with embeddings unconfigured: a natural-language question against a seeded KB returns cited sections rather than a knowledge gap.
