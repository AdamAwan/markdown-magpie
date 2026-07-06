# Question-journey Sankey — design

## Goal

Replace the linear "Gap-to-merge funnel" on the Insights page with a **branching
Sankey diagram** that shows the full journey a question takes — from being asked
(and how confidently it was answered) through gaps, clusters, proposals, and
merge/verification outcomes — including *where the lost volume goes* at each
branch (dismissed, parked, rejected, reopened, …) rather than only the narrowing
trunk a funnel shows.

Scope is v1: a single 30-day-window Sankey, all magnitudes computed from real
columns, no new runtime dependencies (Recharts already ships `<Sankey>`).

## Why a Sankey (and why replace the funnel)

The existing funnel (`/insights/funnel` → `GapFunnelChart`) counts the distinct
entities that *entered* each of seven pipeline stages. It communicates drop-off
but not disposition: it can't show that of the gaps that didn't reach a proposal,
some were dismissed, some parked awaiting a human, some still open. The Sankey is
a strict superset of that information, so the funnel is removed rather than kept
alongside it.

## Non-negotiable: real columns only

Every node and every link magnitude maps to a stored column. No invented or
interpolated numbers. Confirmed column inventory:

- `questions.confidence` — enum `high | medium | low | unknown` (every question
  has exactly one).
- `question_gaps` — lifecycle via terminal timestamps (exactly one set, or all
  null): `resolved_at`, `dismissed_at`, `parked_at`; `question_id` FK to
  `questions`. "Raised a gap" = a question with ≥1 `question_gaps` row.
- `gap_cluster_memberships.active` — a gap is "clustered" when it has an active
  membership (`UNIQUE (gap_id) WHERE active`).
- `proposals.status` — enum `draft | ready | branch-pushed | pr-opened | merged
  | rejected | superseded`; `gap_cluster_id` FK to `gap_clusters`; `merged_at`.
- `proposals.closure_status` — enum `verified_closed | reopened | needs_attention`
  (nullable; set after merge by gap-closure verification).

`proposals.review_decision` (GitHub approval/changes-requested) is deliberately
**out of v1** to keep the graph legible; it is a natural later enrichment of the
proposal stage.

## The flow (nodes → links)

The unit of flow changes across the diagram (question → gap → proposal). This is
normal for a journey Sankey but WILL be labelled on the chart (segment captions /
node subtitles) so counts are not misread as one conserved ribbon.

Segment 1 — Answer outcome (unit: question, questions asked in window):

```
Questions ─┬─ High confidence ────┐
           ├─ Medium confidence ──┤   each confidence node splits into:
           ├─ Low confidence ─────┼──── Raised a gap ─────┐  (→ Segment 2)
           └─ Unknown ────────────┘──── No gap (done)     ×  terminal
```

- `Questions → {confidence}`: count of questions per `confidence` value.
- `{confidence} → Raised a gap`: questions of that confidence with ≥1 gap.
- `{confidence} → No gap`: questions of that confidence with 0 gaps (terminal).

Segment 2 — Gap lifecycle (unit: gap; "Raised a gap" node re-expressed as gap count):

```
Gaps ─┬─ Dismissed        ×  (dismissed_at)
      ├─ Parked           ×  (parked_at)
      ├─ Open (in flight) ×  (all timestamps null AND no active membership)
      └─ Clustered ───────── (active membership) → Segment 3
```

Segment 3 — Proposal lifecycle (unit: proposal, via `gap_cluster_id`):

```
Clustered ── Proposals drafted ─┬─ In progress  ×  (draft|ready|branch-pushed|pr-opened)
                                ├─ Rejected     ×  (rejected)
                                ├─ Superseded   ×  (superseded)
                                └─ Merged ─────── (merged) → Segment 4
```

Segment 4 — Merge verification (unit: proposal):

```
Merged ─┬─ Verified closed   ×  (closure_status = verified_closed)
        ├─ Reopened          ×  (closure_status = reopened)
        ├─ Needs attention   ×  (closure_status = needs_attention)
        └─ (Awaiting check)  ×  (closure_status IS NULL)   — only if > 0
```

`×` = terminal leaf. Recharts sizes each node by max(inflow, outflow), so
terminal leaks and unit changes render correctly without forcing global
conservation.

## Data contract

New payload from `GET /insights/journey` (same 30-day window semantics as the
funnel; `flowId` optional filter preserved from the funnel query where the join
allows it):

```ts
interface JourneyNode { key: string; label: string; segment: "answer" | "gap" | "proposal" | "verify"; }
interface JourneyLink { source: string; target: string; value: number; } // source/target = node key
interface JourneySankey { nodes: JourneyNode[]; links: JourneyLink[]; }
```

The store returns nodes in draw order and only includes links with `value > 0`,
so empty segments collapse cleanly. Recharts `<Sankey>` wants numeric indices for
`source`/`target`; the chart component maps `key` → index before handing data to
Recharts (keeping the API payload human-readable and stable).

## Components & changes

Add:
- `apps/api/src/stores/postgres-insights-store.ts` → `journey(range, flowId?)`
  returning `JourneySankey`. One SQL query (or a small set of CTEs mirroring the
  existing `funnel()` structure) computing every link magnitude above.
- `insights-store.ts` interface + any in-memory/test store → add `journey`.
- `apps/api/src/features/insights/service.ts` + `routes.ts` → `GET
  /insights/journey`.
- `packages/*` shared types (`lib/types.ts` on web, matching core/insights types)
  → `JourneyNode`, `JourneyLink`, `JourneySankey`.
- `apps/web/src/components/insights/useInsights.ts` → `useJourney()`.
- `apps/web/src/components/insights/QuestionJourneyChart.tsx` → Recharts
  `<Sankey>` inside a `<ResponsiveContainer>`, custom node/link renderers themed
  to match the existing charts, tooltips showing node label + value, segment
  captions. Emptiness gating consistent with the other cards (empty when the
  Questions node total is 0).
- `apps/web/src/app/insights/page.tsx` → `useJourney()` + a `ChartCard`
  ("Question journey") in the funnel's former slot (top of the page).

Remove (funnel replacement cleanup):
- `GapFunnelChart.tsx`, `GapFunnelChart.test.tsx`.
- `useFunnel()` in `useInsights.ts` and its usage in `page.tsx`.
- `funnel` from `insights-store.ts` interface + `postgres-insights-store.ts`
  implementation, `service.ts`, and the `/insights/funnel` route in `routes.ts`.
- `FunnelStage` type and any now-unused imports. (knip runs in STRICT mode in CI —
  de-export/delete rather than leave dangling exports.)

## Testing

- Store: a Postgres-backed integration test (gated by `RUN_PG_INTEGRATION`, via
  the throwaway-container harness) seeding questions across all four confidence
  values, gaps in each terminal state, a clustered gap → proposal in each status,
  and merged proposals across each `closure_status`; assert the returned
  `links` magnitudes and that only `value > 0` links appear.
- Chart: an SSR/render test mirroring `GapFunnelChart.test.tsx` — renders with a
  representative payload and with an all-zero payload without throwing.
- Route: extend the insights route test to cover `/insights/journey` shape.

## Out of scope (v1)

- `review_decision` approval/changes-requested arm.
- Configurable window / flow selector UI (window stays fixed 30 days like the
  other v1 charts).
- Click-through / drill-down from a node to the underlying rows.
