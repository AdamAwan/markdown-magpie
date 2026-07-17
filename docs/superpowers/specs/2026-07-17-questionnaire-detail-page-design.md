# Questionnaire detail page + stat banner

## Problem

The Questionnaires console section (`/questionnaires`) stacks everything on one
page: the create form, then the list of questionnaires, then — below the list —
the selected questionnaire's items. Three problems follow from that:

- **It's unclear which questionnaire you're looking at.** The detail simply
  appears under the list; there's no take-over, no strong header, and the list
  stays visible above it.
- **The create form is always in the way.** When reviewing an existing
  questionnaire's answers you still see the "create a questionnaire" form at the
  top.
- **The banner is thin.** The detail header shows only the name and per-item
  badges — no at-a-glance breakdown of how many are answered, in progress,
  unanswerable, etc.

## Goals

1. Drilling into a questionnaire opens a **full page** with its own URL and a
   clear way back to the list.
2. The create form is **not present** on the detail page.
3. The detail page carries a **stat banner** summarising item states.

Non-goals: changing the API, the questionnaire data model, export, approval
behaviour, or the create flow's inputs. This is a web-UI restructuring only.

## Approach

Introduce the app's first dynamic route, `/questionnaires/[id]`, and split the
single `QuestionnairesPanel` into an index (create + list) and a detail
(banner + items) component. The `ConsoleProvider` data layer
(`listQuestionnaires`, `getQuestionnaire`, `createQuestionnaire`,
`approveQuestionnaireItem`, `approveReusedItems`) is unchanged and reused by
both pages.

### Routing

- **New route** `apps/web/src/app/questionnaires/[id]/page.tsx` — a client
  component (`"use client"`) that reads the id with `useParams()`, fetches via
  `getQuestionnaire(id)`, and owns the polling loop (see below).
- **Index page** `apps/web/src/app/questionnaires/page.tsx` — renders only the
  create form and the list. List rows navigate to `/questionnaires/<id>` with
  `router.push`. A successful create navigates to the new questionnaire's page.
- **Nav highlight** — `sectionFromPath` (in `apps/web/src/lib/sections.ts`)
  currently matches the pathname **exactly**, so `/questionnaires/<id>` would
  fall through to the default section ("ask") and mis-highlight the sidebar and
  topbar title. Change it to **longest-prefix** matching: pick the `SECTION_NAV`
  entry whose `path` is a prefix of the pathname, preferring the longest match.
  `/` (root) must keep matching only the root, not every path — handle the root
  entry as an exact match, or exclude a bare `/` from prefix matching. Add unit
  coverage for `/questionnaires/abc → questionnaires` and for existing exact
  paths still resolving correctly.

### Component split

Replace `apps/web/src/components/QuestionnairesPanel.tsx` with:

- **`QuestionnaireCreateList.tsx`** — the create form (Name, Flow, Questions,
  Create button) plus the list of `QuestionnaireSummary` rows. Props: `flows`,
  `loading`, `onList`, `onCreate`, and an `onOpen(id: string)` callback invoked
  on both a successful create and a row click. The page supplies `onOpen` as a
  `router.push('/questionnaires/<id>')` wrapper, keeping the component free of
  `next/navigation` so it tests without a router mock. Owns the list-refresh +
  create logic currently in the panel.
- **`QuestionnaireDetail.tsx`** — back link, header, stat banner, actions
  (approve-all-reused, export), and the item cards. Props: `questionnaire`,
  `onApproveItem`, `onApproveReused`, `onRefresh`, `exportHref`. Owns the
  per-item approve and approve-all-reused handlers and the active-item polling.
- **`questionnaireItems.ts`** — shared pure helpers `itemTone`, `itemLabel`,
  `changeReasonText` (moved verbatim from the current panel) used by the detail
  component (and tests).

`QuestionnairesPanel.tsx` is removed; its test file is split to match the two
new components.

### Detail page layout (top to bottom)

1. **Back link** `← Questionnaires` → `/questionnaires` (a styled `next/link`).
2. **Header** — questionnaire `name` as a page heading, with the flow id as a
   neutral `Badge` beside it, so the subject is unmistakable.
3. **Stat banner** — the tiles below, computed live from `questionnaire.items`.
4. **Actions** — `Approve all reused`, `Export .md`, `Export .csv` (unchanged
   behaviour).
5. **Items** — the existing item-card rendering, unchanged.

### Stat banner

A small presentational `StatBanner` (new; no reusable stat-tile exists today).
It renders a horizontal, wrapping row of labelled count tiles. Counts are
derived from `questionnaire.items` in the detail component — **not** from
`QuestionnaireSummary.counts` — because the items expose states the summary
folds away (notably `answering`). Full tile set:

| Tile | Derivation |
| --- | --- |
| Total | `items.length` |
| Approved | `status === "approved"` |
| Awaiting approval | `status === "answered"` |
| In progress | `status === "pending" \|\| status === "answering"` |
| Unanswerable | `status === "unanswerable"` |
| Reused | `outcome === "reused"` |

Tiles are presentational only (label + number); no tone/colour semantics are
required beyond the existing theme text/muted colours. "Reused" overlaps the
answered/approved buckets by design (it's an outcome, not a status) — it reads
as "of these, how many were reused," which matches the questionnaire model.

### Polling

The active-item polling currently in `QuestionnairesPanel` moves into
`QuestionnaireDetail` (or the detail page). Unchanged logic: while any item is
`pending` or `answering`, poll `getQuestionnaire(id)` every
`POLL_INTERVAL_MS` (5s) and stop when nothing is active. The server read also
resumes a stalled drip, so the poll doubles as restart recovery — preserve that
comment. The index page does not poll per-item; it refreshes its list on mount
(and after create), as today.

## Data flow

```
/questionnaires (index)
  QuestionnaireCreateList
    onList()   -> summaries (list)
    onCreate() -> created questionnaire -> router.push(/questionnaires/<id>)
    row click  -> router.push(/questionnaires/<id>)

/questionnaires/[id] (detail)
  useParams() -> id
  getQuestionnaire(id) -> questionnaire (on mount + poll while active)
  QuestionnaireDetail
    onApproveItem(id, itemId)
    onApproveReused(id)
    exportHref(id, "md"|"csv")
```

## Error / edge handling

- **Unknown / bad id**: `getQuestionnaire` already surfaces API errors via the
  provider's toast and returns `undefined`. The detail page shows an
  `EmptyState` ("Questionnaire not found") with the back link when the fetch
  yields nothing, rather than a blank page.
- **Loading**: before the first fetch resolves, show a minimal loading state (or
  the empty header) — do not flash "0" tiles as if they were facts.
- **Direct navigation / refresh** on a detail URL works because the page fetches
  by id on mount (no reliance on list state being loaded first).

## Testing

- `sections.test.ts` (new or extended): `/questionnaires/<id>` resolves to the
  `questionnaires` section; existing exact paths and `/` still resolve
  correctly.
- `QuestionnaireCreateList.test.tsx`: renders the form + list; creating
  navigates; a row click navigates (assert the router push target).
- `QuestionnaireDetail.test.tsx`: given a questionnaire with a mix of item
  states, the stat banner shows the correct six counts; approve / approve-all /
  export controls are present; the create form is **absent**.
- `questionnaireItems.test.ts`: the moved helpers keep their current behaviour
  (port any existing assertions).

Run `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`,
`npm run deadcode` as the split lands (de-export anything that becomes unused
rather than relaxing knip).

## Open decisions (resolved)

- **View mechanism**: real route `/questionnaires/[id]` (not an in-panel swap) —
  chosen for deep-linking and browser Back.
- **Stat tiles**: the full six-tile set above.
