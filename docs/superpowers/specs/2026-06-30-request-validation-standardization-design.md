# Standardize HTTP request-body validation on `zValidator`

**Date:** 2026-06-30
**Status:** Approved (design)

## Problem

A code-quality audit flagged inconsistent and partly-unsafe JSON request validation
across `apps/api`:

1. **Latent bug in `features/gaps/routes.ts`.** Both body-reading endpoints parse with
   `const body = (await c.req.json().catch(() => ({}))) as {...}` and then hand-written
   type guards. A *present-but-malformed* body is silently swallowed into `{}`, so
   fields become `undefined` instead of the request being rejected. Observed today:
   - `POST /api/gaps/reconcile` with malformed JSON → `400 flow_id_required` (only a
     400 by accident, because `flowId` happens to be required).
   - `POST /api/gaps/clusters/:id/proposal` with malformed JSON → request proceeds as
     if no overrides were sent, ending in `404 cluster_not_found`. A malformed body is
     **silently accepted**. This is the real latent bug.

2. **Three validation styles coexist.** `zValidator("json", schema, hook)` from
   `@hono/zod-validator` (ask, retrieve, questions-feedback, proposals-status), a
   `readJsonBody` cast helper (7 files), and a `parseJsonBody` schema helper (1 file),
   plus the unsafe manual pattern in gaps. All ultimately use zod schemas; only the
   wrapper differs.

## Decision

**Canonical adapter: `@hono/zod-validator`'s `zValidator("json", schema, hook)`.**
The library is the maintained, ecosystem-standard middleware; schemas stay in
`features/*/schema.ts`. We converge the schema-driven routes onto it rather than
inventing a new abstraction.

### Critical finding that shapes the design

`zValidator`'s `"json"` target calls Hono's `validator`, which **throws
`HTTPException(400, "Malformed JSON in request body")`** when the body has a JSON
content-type but is unparseable (and also on an empty body with a JSON content-type).
That `HTTPException` is *not* this app's `HttpError`, so it falls through the custom
`onError` ([http/errors.ts](../../../apps/api/src/http/errors.ts)) to the catch-all
branch → **`500 internal_error`**.

Empirically confirmed (probe against the in-memory test app):

| Request | Today |
| --- | --- |
| `POST /api/ask` (zValidator) + malformed JSON | **500** `internal_error` |
| `POST /api/ask` + empty body **with** `content-type: application/json` | **500** `internal_error` |
| `POST /api/ask` + no body, no content-type | `400 question_required` |
| `POST /api/gaps/reconcile` (manual) + malformed JSON | `400 flow_id_required` |
| `POST /api/gaps/clusters/:id/proposal` (manual) + malformed JSON | `404 cluster_not_found` |

So a naive swap of gaps to `zValidator` would make malformed input return **500**, a
regression vs. the task requirement (malformed/invalid input must return a proper
`400` with the `{ error: <code> }` shape). The existing `zValidator` routes already
carry this latent 500-on-malformed-JSON bug — their hooks only fire for *schema*
failures, which happen *after* the throw.

### Fix: translate `HTTPException` in the global `onError`

`onError` gains a branch: any Hono `HTTPException` (the only source in this app is the
validator's malformed-body throw) is rendered as the codebase's standard shape
`{ error: "invalid_json" }` at the exception's status (400). This:

- keeps every call-site pure-library (`zValidator("json", schema, hook)`, no custom
  wrapper),
- satisfies the task's "400 on malformed input" requirement for gaps, and
- as a bonus fixes the same latent 500 across **all** `zValidator` routes.

`bodyLimit` keeps its own `onError` (413) and is unaffected.

## Scope

Schema-backed routes only. Routes that already drive a zod schema converge on
`zValidator`; schema-less `readJsonBody` routes are left untouched (out of scope —
they would require inventing shape decisions for currently un-validated bodies).

### Changes

1. **New `apps/api/src/features/gaps/schema.ts`**
   ```ts
   import { z } from "zod";

   export const reconcileBodySchema = z.object({
     flowId: z.string().trim().min(1)
   });

   export const draftFromClusterBodySchema = z.object({
     targetPath: z.string().optional(),
     destinationId: z.string().optional()
   });
   ```
   - `reconcileBodySchema` trims then requires non-empty, preserving today's
     whitespace-only-`flowId` → 400 behavior. The validated `flowId` is already
     trimmed, so the handler drops its manual `.trim()`.
   - `draftFromClusterBodySchema` keeps the body optional; only wrong-*typed*
     overrides (e.g. `targetPath: 123`) now 400 instead of being coerced to
     `undefined`.

2. **`apps/api/src/features/gaps/routes.ts`** — replace both manual blocks with
   `zValidator` middleware:
   - `POST /reconcile`: hook → `c.json({ error: "flow_id_required" }, 400)`. Handler
     reads `c.req.valid("json").flowId`, keeps the `404 flow_not_found` config check
     and the `reconcileFlow` call. Response unchanged (`{ ok: true }`).
   - `POST /clusters/:id/proposal`: hook → `c.json({ error: "invalid_proposal_overrides" }, 400)`
     (new code; only fires on wrong-typed overrides). Handler reads the validated
     overrides, keeps the `draftFromCluster` call and the existing
     `404 { error: outcome.code }` / success response shapes.

3. **`apps/api/src/http/errors.ts`** — `onError` translates `HTTPException` →
   `c.json({ error: "invalid_json" }, error.status)`. Import `HTTPException` from
   `hono/http-exception`. The existing `HttpError` and catch-all `500` branches are
   unchanged and still take precedence for `HttpError`.

4. **Sweep — converge remaining schema-driven routes onto `zValidator`**, preserving
   every existing error code and status:
   - `features/proposals/routes.ts` `/from-gap` + `/from-gaps`:
     `parseJsonBody(c, draftFromGapsBodySchema, "gap_summary_required")` →
     `zValidator("json", draftFromGapsBodySchema, hook→gap_summary_required)`.
   - `features/jobs/routes.ts`: `readJsonBody` + manual `safeParse` →
     `zValidator` for the four strict 400 paths, codes preserved:
     - `POST /` → `invalid_job`
     - `POST /claim` → `worker_capabilities_required`
     - `POST /:id/complete` → `invalid_output` (the surrounding `try/catch` for
       service errors stays; middleware runs before the handler)
     - `POST /:id/fail` → `invalid_job_error`
   - **Left as-is:**
     - `jobs` `POST /:id/heartbeat` — parses *leniently*
       (`parsed.success ? data.workerName : undefined`); it is an optional-body path,
       not a 400 path, so it keeps `readJsonBody`.
     - Schema-less `readJsonBody` routes: config, patrol, source-sync,
       scheduled-tasks, knowledge, and questions-summary.
   - Already `zValidator`, unchanged (but now benefit from the malformed-JSON fix):
     ask, retrieve, questions-feedback, proposals-status.

5. **Dead-code (knip STRICT).** `parseJsonBody` loses its only caller → remove it
   (and its export) from `apps/api/src/http/body.ts`. `readJsonBody` and the private
   `readRawJson` remain (still used by the schema-less routes). Do **not** relax knip
   config.

### Non-goals

- No new validation abstraction/wrapper.
- No migration of schema-less `readJsonBody` routes (would require inventing body
  shapes that aren't validated today).
- No response-shape or status-code changes beyond turning the documented
  malformed/invalid-input cases into the intended `400 { error: <code> }`.

## Error-behavior matrix (after the change)

| Endpoint | Input | Result |
| --- | --- | --- |
| `/api/gaps/reconcile` | malformed JSON | `400 { error: "invalid_json" }` |
| `/api/gaps/reconcile` | `{}` / missing / whitespace `flowId` | `400 { error: "flow_id_required" }` |
| `/api/gaps/reconcile` | unknown `flowId` | `404 { error: "flow_not_found" }` |
| `/api/gaps/reconcile` | valid configured `flowId` | `200 { ok: true }` |
| `/api/gaps/clusters/:id/proposal` | malformed JSON | `400 { error: "invalid_json" }` |
| `/api/gaps/clusters/:id/proposal` | `targetPath: 123` (wrong type) | `400 { error: "invalid_proposal_overrides" }` |
| `/api/gaps/clusters/:id/proposal` | `{}` / valid overrides / no body | unchanged (proceeds; `404`/success as before) |
| `/api/ask` (and other zValidator routes) | malformed JSON | `400 { error: "invalid_json" }` (was 500) |

## Testing

Test-first. Extend `apps/api/src/features/gaps/routes.test.ts`:

- `POST /reconcile` malformed JSON → `400 { error: "invalid_json" }`.
- `POST /reconcile` whitespace-only `flowId` → `400 { error: "flow_id_required" }`.
- `POST /clusters/:id/proposal` malformed JSON → `400 { error: "invalid_json" }`.
- `POST /clusters/:id/proposal` wrong-typed override → `400 { error: "invalid_proposal_overrides" }`.
- `POST /clusters/:id/proposal` valid overrides still reaches the service (existing
  success/404 path preserved).

Add a regression test (gaps or a small `http/errors`-level test) proving a malformed
JSON body to an existing `zValidator` route (`/api/ask`) now returns
`400 { error: "invalid_json" }` rather than `500`.

Existing `gaps/routes.test.ts` cases (missing `flowId` → 400, configured `flowId` →
200, unknown `flowId` → 404) must continue to pass unchanged.

## Quality gates

`npm run typecheck`, `npm run lint`, `npm run deadcode` (knip STRICT), and `npm test`
must stay green. The full `test:db` suite (Docker) runs in CI.
