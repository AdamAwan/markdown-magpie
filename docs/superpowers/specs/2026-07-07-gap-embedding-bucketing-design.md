# Embedding-based phase-1 gap bucketing — design

Date: 2026-07-07
Status: approved

## Problem

The gap reconciler's clustering has two phases (`reconcileClusters()` in
`apps/api/src/scheduling/gap-reconciler.ts`):

- **Phase 1 — assignment (deterministic):** each unassigned gap is bucketed by exact
  summary string (`gapSummaryKey(summary, flowId)`; `listGapCandidates` groups
  `question_gaps` rows by literal `(summary, flow_id)`). Gap summaries are free-text
  model output, so distinct wordings never group. A real incident produced 100 gaps
  with 0 exact-duplicate strings → 100 singleton clusters.
- **Phase 2 — reshape (AI):** a `reconcile_gap_clusters` propose→critic job
  merges/splits/dismisses. Today this is the only step that collapses near-duplicates
  — a single point of failure. When it under-performs, ~100 proposals fan out.

Phase 1 does no semantic work. This design makes it a cheap coarse pre-clusterer
using embeddings, so reshape shrinks from "discover all merges across 100
singletons" to "adjudicate ~15 borderline buckets". **Reshape stays the semantic
refiner** — nothing about it is removed or weakened.

## Decisions (locked in brainstorming)

1. **Cluster representative = centroid, incrementally updated.** The mean of the
   embeddings of the cluster's *distinct active member summaries*, L2-normalised.
   Phase-1 joins update it incrementally; reshape-applied composition changes null it
   for lazy recompute (below).
2. **Per-gap embeddings are not persisted.** Candidates are ≤200 short strings per
   tick — one batched `embed()` call. Only the cluster representative persists.
3. **Threshold `T`: eval-driven, starting hypothesis 0.90, env-overridable.** A named
   constant `DEFAULT_GAP_ASSIGN_THRESHOLD` (final value set by the offline eval's
   evidence), overridable via `GAP_CLUSTER_ASSIGN_THRESHOLD`, validated in
   `loadConfig` and read off `ctx.settings` — never `process.env` directly.
4. **Determinism: batch pass, not greedy.** All decisions are made against a
   tick-start snapshot; unmatched candidates cluster by connected components.

## Assignment algorithm (replaces step 1 of `reconcileClusters`, per flow, per tick)

1. Gather unassigned candidates exactly as today: `listGapCandidates` → flow filter
   → `gapIdsForSummaries` → drop gaps already in an active membership.
2. **No embedding provider configured** (`ctx.providers.embedding` undefined —
   keyword-only deployments, in-memory unit tests) → fall back to today's
   one-cluster-per-distinct-summary behaviour, unchanged.
3. Otherwise embed all candidate summaries in one batched `provider.embed()` call;
   L2-normalise the vectors.
4. Load `listActiveClustersForFlow(flowId)`. Any active cluster missing a
   representative embedding (pre-migration rows, or nulled after a reshape) gets it
   recomputed here: embed its distinct active member summaries, take the normalised
   mean, persist. This doubles as the backfill for legacy clusters.
5. **Stage A — join existing clusters:** score every candidate against every
   same-flow active-cluster representative using the *tick-start snapshot* of
   representatives. If the max cosine ≥ `T`, the candidate's gaps join that cluster.
   Ties broken by cluster id ascending (deterministic). Decisions come from the
   snapshot; centroid updates are applied afterwards — order-independent.
6. **Stage B — seed new clusters:** unmatched candidates form a graph (edge =
   pairwise cosine ≥ `T`, same flow only); each connected component seeds one new
   cluster. Title = lexicographically-first member summary truncated to 80 chars
   (matching today's truncation); representative = normalised mean of the component's
   embeddings.
7. Persist Stage-A centroid updates as a weighted mean over distinct member
   summaries (prior distinct-summary count from the membership store).

Never compare across flows (inputs are already flow-scoped). Frozen/dismissed
clusters never participate (`listActiveClustersForFlow` excludes them).

## Centroid maintenance

- Definition: centroid = normalised mean of embeddings of the cluster's **distinct
  active member summaries** (duplicate identical summaries don't dominate).
- Phase-1 join: incremental weighted mean, then re-normalise.
- Reshape-applied composition change (merge survivor, split retained cluster and its
  children) **nulls** the representative; step 4 recomputes it lazily on the next
  assignment pass. One recompute code path, no drift.

## Failure semantics

- **Provider absent** (deployment state, deterministic): exact-string fallback.
- **Provider present but `embed()` throws** (infra failure): the reconcile run fails
  — recorded as a failed MaintenanceRun and rethrown, retried next tick. Mirrors the
  #150 principle: infra failure retries; it never silently degrades into the
  100-singleton behaviour.

## Storage

Migration `0046_gap_cluster_representative.sql` (append-only, `write-a-migration`
conventions):

```sql
ALTER TABLE gap_clusters
  ADD COLUMN IF NOT EXISTS representative_embedding vector(1536);
```

Nullable — null means "recompute lazily". No ANN index: per-flow active cluster
counts are small and similarity is computed in JS against the loaded set.

Store changes (`GapClusterStore` interface + in-memory + Postgres impls):

- `GapClusterRecord.representativeEmbedding?: number[]`
- `CreateClusterInput.representativeEmbedding?: number[]`
- `setClusterRepresentative(id: string, embedding: number[] | null): Promise<void>`

## Config

- `DEFAULT_GAP_ASSIGN_THRESHOLD` — named, documented constant (starting hypothesis
  0.90; final value confirmed by the eval).
- `GAP_CLUSTER_ASSIGN_THRESHOLD` env var → `AppConfig.gapClustering.assignThreshold`,
  validated in `loadConfig` (finite, in (0, 1]); the reconciler reads
  `ctx.settings`, never `process.env`.

`T` is deliberately conservative: it collapses only obvious paraphrases ("TLS
versions in transit" ≈ "encryption protocols in transit"). Semantic cousins
("encryption in transit" vs "encryption at rest", ~cosine 0.85) are **reshape's
job** and must stay below `T`.

## Pure core

Geometry and bucketing live in a new pure module
`apps/api/src/scheduling/gap-assignment.ts`: normalise, cosine, and a
snapshot-based Stage A/B planner that takes (candidate vectors, cluster
representatives, T) and returns join/new-cluster decisions. No I/O — unit-testable
offline with synthetic vectors, including an order-independence property test.

## Threshold eval (before committing to T)

A script under `scripts/` (eval-script conventions from `writing-magpie-tests`):

- Constructed labelled corpus: ~15 paraphrase themes × 3–6 wordings, ~20
  genuinely-distinct singletons, plus known near-cousin traps (encryption
  in-transit vs at-rest, TLS vs SSH, backup retention vs log retention).
  Constructed because no labelled production corpus exists; themes mirror the
  incident's compliance-questionnaire domain.
- Embeds with the real configured provider (`.env` credentials); caches vectors to
  a committed JSON fixture so re-runs are deterministic and offline.
- Sweeps T, reporting pairwise precision/recall over same-theme pairs and the
  over-merge count (distinct themes joined).
- Chosen T = lowest value with zero over-merges, plus a safety margin; reported
  with evidence in the eval output and this spec's implementation notes.

## Preserved safeguards (must stay green)

- Reshape propose→critic flow and the `reshapeCompositionHash` short-circuit.
- Membership pruning, cluster lineage/survivor selection, per-flow scoping,
  publication outbox, in-flight draft coverage.
- The full existing `gap-reconciler.test.ts` suite (its contexts have no embedding
  provider, so it exercises the fallback path).

## Testing

- Pure planner unit tests (components, snapshot semantics, threshold edges,
  order-independence, tie-breaking).
- Reconciler unit tests with a deterministic fake embedding provider: paraphrases
  land in one cluster; distinct gaps seed separate clusters; a re-raised identical
  gap re-joins its cluster across ticks; frozen clusters excluded; centroid
  updates persist; reshape-applied changes null the representative and it is
  recomputed next tick; provider-absent fallback = old behaviour; embed failure
  fails the run.
- Store tests (in-memory + Postgres via `RUN_PG_INTEGRATION`): representative
  round-trip including null-ing; migration applied by the throwaway-container
  harness.

## Docs

Update `docs/architecture.md` (gap-reconciler section) and the env-var reference
for `GAP_CLUSTER_ASSIGN_THRESHOLD` alongside the code.
