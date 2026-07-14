# MCP citation tool (`kb_citation`) — design

**Date:** 2026-07-14
**Status:** Approved

## Problem

`kb_ask` answers carry citations shaped `{documentId, sectionId, path, heading, anchor,
excerpt, relevance, commitSha?}` — only a short `excerpt` of the evidence. MCP end users
cannot see the full cited passage without leaving the MCP client. The knowledge index
already holds every section's full content and exposes it wholesale via
`GET /api/knowledge/search` at the `read:knowledge` scope, but there is no way to resolve
a *specific* section by id.

## Decision

Add a section-id lookup end to end: a new API endpoint that resolves one section by id,
and a new MCP tool `kb_citation` (both transports) that takes the `sectionId` values off
`kb_ask` citations and returns the full section content.

Addressing is **by sectionId(s)** (approved over questionId-based and hybrid
alternatives): it composes with both `kb_ask` citations and `kb_search` results, and
keeps the API surface a plain resource lookup.

## API: `GET /api/knowledge/sections/:id`

- Route in `apps/api/src/features/knowledge/routes.ts`, guarded by
  `requireScopes("read:knowledge")` — the same scope as `/knowledge/search`, which
  already returns full section content, so this exposes nothing new.
- Backed by a new `getSection(id: string): DocumentSection | undefined` on
  `InMemoryKnowledgeIndex` (`apps/api/src/stores/knowledge-index.ts`) — a lookup on the
  in-memory sections map the index already maintains.
- 200 body: `{ section: { id, documentId, path, heading, headingPath, anchor, content,
  ordinal } }` (the full `DocumentSection` shape from `@magpie/core`).
- 404 `section_not_found` when the id is not in the index (e.g. the section was
  re-indexed away since the answer was produced).

## MCP tool: `kb_citation`

Registered in both transports — stdio (`apps/mcp/src/main.ts`) and Streamable HTTP
(`apps/mcp/src/http.ts`) — with the fetch/aggregate logic shared in
`apps/mcp/src/kb-client.ts` so the transports cannot drift.

- **Input:** `sectionIds: string[]`, 1–20 entries, each a non-empty string. The values
  come from `kb_ask` citations (`citations[].sectionId`) or `kb_search` results.
- **Behaviour:** fan out one `GET /knowledge/sections/:id` per id in parallel and
  aggregate. A 404 for an id records it in `missing` instead of failing the call, so a
  stale citation does not hide the evidence that still resolves. Any non-404 API failure
  fails the tool call (existing error pattern).
- **Output:** `{ sections: DocumentSection[], missing: string[] }`.
- **Description** (model-facing): content is the *currently indexed* version of the
  cited section, which may have changed since the answer was produced; a `missing` id
  means the knowledge base changed — re-ask or use `kb_search`.
- **HTTP transport scopes:** `TOOL_SCOPES["kb_citation"] = "read:knowledge"`
  (`read:knowledge` is already in `SCOPES_SUPPORTED`).

## Error handling

- Tool input validation (missing/empty array, non-string entries, > 20 ids) → clear
  tool error naming the argument.
- API 404 per id → `missing` entry, never a tool failure.
- Other API errors → tool error (propagated as today for every kb_* tool).

## Testing

Colocated `node:test` suites, following existing patterns:

- `knowledge-index`: `getSection` returns an indexed section; unknown id → undefined.
- knowledge routes: 200 happy path with the full section body; 404 with
  `section_not_found`; scope guard consistent with the other knowledge routes.
- `kb-client`: aggregation of found + missing ids; input validation errors; non-404
  failure propagation.
- stdio + HTTP transports: `kb_citation` appears in `tools/list`; `tools/call` dispatch;
  HTTP per-tool scope enforcement (403 without `read:knowledge`).

## Documentation

- `docs/mcp.md` — add the tool, update the tool count (six → seven).
- `docs/api.md` — add the endpoint.
- `.claude/skills/magpie-orientation/SKILL.md` — §2.19 tool list/count.
- Any other place that enumerates the MCP tool list (checked during implementation,
  e.g. the console `/mcp` page).

## Out of scope

- questionId-based batch resolution (rejected alternative).
- Returning the section as of the cited `commitSha` (the index holds only the current
  version; the citation's `excerpt` remains the as-answered evidence).
- Whole-document retrieval.
