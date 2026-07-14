# Status pill + notifications — console notification redesign

**Date:** 2026-07-14
**Status:** Approved (Adam picked Option A of three mocked options, extended with
warning/generic-notification support; feedback keeps a toast *and* lands in the
dropdown list).

## Problem

The console renders two things between the topbar and the page content
(`apps/web/src/components/AppShell.tsx`):

1. A transient `Alert` banner for action feedback ("Proposal merged…", errors),
   auto-dismissed after 5 s (10 s for danger).
2. `AttentionPanel` — the persistent system notices from `buildAttentionNotices`
   (API offline, failed jobs, watcher warnings, capability gaps) as full-width
   stacked cards.

Both mount and unmount as the 4 s poll runs, so the page content jumps
constantly, and several stacked cards can consume much of the viewport. Too
loud, too jumpy.

## Design

Replace both with a **status pill** in the topbar plus **overlay toasts**.
Nothing notification-related remains in the document flow, so layout shift is
impossible by construction.

### One notification model

- `UiMessage` becomes `UiNotification { id: number; text: string;
  tone: "info" | "success" | "danger"; at: string; read: boolean }` in
  `apps/web/src/lib/types.ts`.
- `showMessage(text, tone)` keeps its signature (call sites untouched).
  Internally each call prepends an unread notification to a session-state list
  **capped at the newest 20**, and shows a toast for the same notification.
- No persistence: the list is ConsoleProvider state, exactly like today's single
  message.

### The pill

- Always mounted in the topbar actions row (next to Refresh); constant size.
- **Colour = worst outstanding severity** across system notices and *unread*
  notifications: danger > warning > info; success counts as info. Healthy and
  nothing unread = neutral pill with a green dot.
- **Label**: `"N issues"` when any danger notice is present, `"N warnings"` when
  notices are warning-only, plus `" · M new"` for unread notifications;
  `"All clear"` when there is nothing. Before the first refresh completes the
  pill shows a neutral "Checking status" (same gating reason as the old
  `hasLoaded` guard: pre-load defaults are placeholders, not facts).
- Clicking opens an anchored dropdown with two groups:
  - **Needs attention** — the unchanged `buildAttentionNotices` output with
    their existing action chips ("Open Jobs" etc.). Not dismissable; they clear
    when the underlying condition clears.
  - **Recent** — the notification list, newest first, with per-item dismiss and
    a Clear button. Unread rows are highlighted.
- Opening the dropdown marks all notifications read.
- Dropdown closes on outside click and Escape.

### Toasts

- Fixed-position stack, bottom-right, `aria-live="polite"`.
- Auto-dismiss after 5 s (10 s danger) — same timings as the old banner — plus a
  manual dismiss button.
- A toast is a *view* of a notification; dismissing the toast never removes the
  notification from the Recent list.

### Removals and simplifications

- `AppShell` no longer renders `Alert` or `AttentionPanel`; both components and
  the `alertTone` map are deleted.
- `clearMessage()` existed to wipe the stale single banner before each action.
  Toasts stack and expire on their own, so `clearMessage` and the
  `preserveMessage` refresh option are removed along with every call site.
- `buildAttentionNotices` and `jobTransitionMessages` are unchanged.

## Components

- `apps/web/src/components/StatusPill.tsx` — props-driven presentational
  component (notices, notifications, callbacks for open/dismiss/clear), so it is
  testable with the repo's SSR-markup harness. Rendered by `AppShell` from
  `useConsole()` state.
- `apps/web/src/components/ToastStack.tsx` — props-driven toast stack.
- Pure helper `pillSummary(notices, unreadNotifications)` in
  `apps/web/src/lib/console.ts` returning `{ label, tone }`, unit-tested next to
  `buildAttentionNotices`'s tests.

## Testing

- `pillSummary` unit tests: severity precedence, count/label wording,
  all-clear state.
- `StatusPill` / `ToastStack` markup tests following `ui.test.tsx` conventions
  (tones as data hooks, accessible names, unread highlighting).
- Existing `console.test.tsx` suites stay green (no behavioural change to
  notice building or job-transition messages).

## Out of scope

- Cross-session notification persistence and read-state storage.
- Server-pushed notifications.
- The sidebar's live status block (unchanged).

## Mockup

Interactive mockup (pill states, dropdown grouping, toasts, read semantics):
claude.ai artifact `681238d9-873e-494c-b304-9b852cd9afc0`
("Status bar options — Magpie notification redesign").
