# Intent Trace UI Design

## Goal

Surface change intents in the Activity UI so operators can understand what a maintenance run considered, what the reconcile gate decided, and where the work went next, while still giving developers a raw payload view for debugging.

## Approach

Activity remains the primary audit surface. Each maintenance run may carry intent traces in its durable details payload. Rows show compact chips for intent counts and gate outcomes, and a trace control opens a focused debug view with the full intent, gate context, and outcome.

The first implementation stores typed `ChangeIntentTrace` records inside `MaintenanceRun.details.intentTraces`. This avoids a migration and fits the current JSONB run-audit model. The shared type is defined in `@magpie/core` so the API, watcher, and web app agree on the shape. A future dedicated Intents page can promote the same records into a table if filtering becomes important.

## Trace Shape

Each trace wraps the existing `ChangeIntent` fields plus reconciliation metadata:

- `intent`: lens, flow id, target paths, evidence, rationale.
- `decision`: `open-new`, `fold`, `defer`, or `drop`.
- `candidatePullRequests`: proposal ids, targets, touchable flag, and overlap paths the gate considered.
- `outcome`: proposal id/title/status, pull request URL when known, fold job id when created, and a short reason when no proposal is produced.
- `createdAt`: timestamp for ordering inside the run.

## UI

Activity rows stay readable. They add chips such as `1 intent`, `opened proposal`, `folded`, and `deferred` when traces exist. A `View trace` button appears only for runs with traces.

The trace view is a modal-style expanded panel in the row. It shows one trace card per intent with the operator story first: lens, decision, targets, rationale, and outcome. Developer details sit behind a native disclosure with raw JSON so debugging does not crowd the main UI.

## Scope

This change does not add a separate Intents page, database table, or full replay system. It records traces only where the existing run audit can naturally hold them. Existing runs without traces continue to render normally.

## Testing

Core tests validate the trace type through maintenance run storage. API/scheduling tests cover traces attached to gap reconciliation and patrol runs where practical. Web tests cover Activity chips, the trace button, and raw debug content rendering.
