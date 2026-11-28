# Archive — historical documents

Everything in this folder describes **finished or superseded work**. These files are kept
for context only: they are **not maintained**, are not part of the living spec set, and
must not be read as a description of how the system behaves today. For current behaviour
start at [`../README.md`](../README.md); when a file here and the code disagree, the code
(and the living specs) win.

Files are moved here unedited, so repository paths inside them are as they were when the
document was last touched.

| Document | What it was | Why it is archived | Read instead |
| --- | --- | --- | --- |
| [mvp.md](./mvp.md) | The original three-milestone MVP roadmap (cited answers → gap loop → pull requests) plus a "Later" wish-list. | All three milestones shipped long ago, and the "Later" items were built under different names (patrols, dedupe lens, source conflicts, citation usage, the freshness chart). | [`../architecture.md`](../architecture.md) |
| [scheduled-jobs-migration-status.md](./scheduled-jobs-migration-status.md) | Status tracker for moving scheduled work from in-process / Crunch jobs onto pg-boss schedules (last updated 2026-06-27). | The migration is complete: scheduling is pg-boss-backed, `/api/crunch` and the crunch tables are gone, and source-sync produces first-class proposals. Its own checklist is out of date (it still shows the shipped "Scope B" unticked). | [`../gaps-and-maintenance.md`](../gaps-and-maintenance.md), [`../source-sync.md`](../source-sync.md), [`../ai-jobs.md`](../ai-jobs.md) |

One follow-up recorded in the migration tracker was never done and is still true of the
code: source-sync keeps its own `SourceSyncRun` lifecycle rather than recording a generic
`MaintenanceRun`. That is a backlog note, not reference material — track it as an issue
rather than reviving the tracker.

## Not here: `maintenance-redesign.md`

[`../maintenance-redesign.md`](../maintenance-redesign.md) (and its visual companion
`maintenance-redesign.html`) is also a shipped, partly superseded design record, but it
stays in `docs/` deliberately: source comments in `apps/api/src/scheduling/` and
`apps/api/src/features/patrol/` cite its _Decisions_ section as the rationale for the
patrol-cursor and dedupe-neighbourhood tunables, and the dated design docs under
`docs/superpowers/` (never retro-edited) link to it by relative path. It carries a status
banner saying what in it is and is not current.

`docs/superpowers/` is the other historical record — dated design specs, plans and task
reports. It is an append-only archive in its own right and is not moved here.
