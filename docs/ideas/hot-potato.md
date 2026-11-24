# Hot Potato — forced, audited sign-off for questionnaires

> **Status:** idea (2026-11-24). Not built, not scheduled. A companion tool that *uses*
> Magpie; it is deliberately **not** part of Magpie.
>
> **Name:** a questionnaire review is a hot potato: nobody wants to hold it. Hot Potato
> makes sure someone has to, and keeps a record of who did.

## The problem

Magpie is good at answering security questionnaires, but not perfect — and the documents
we get sent are often confusing and badly formatted. So a filled-in questionnaire can have
answers in the wrong place, or answers that misread the question's context.

That's fixable with a review. The real problem is that **nobody owns the review**:

1. Someone grabs a document and fills it with a tool.
2. They post "is this right? can someone review?"
3. Everyone ignores it, because no one is clearly responsible.

We'll never be perfect. What we need is a review that **can't be skipped and can't be
dodged**.

## The idea

1. A user uploads the questionnaire (Excel / Word / etc.).
2. Hot Potato uses Magpie to fill it in.
3. **Every row is assigned a named owner**, who must sign it off.
4. Once every row is signed off, **one person signs off the whole document**.
5. Every action is recorded in an audit trail, so it's always clear who signed what, and
   who hasn't.

## What Magpie already gives us

From [questionnaires.md](../questionnaires.md):

- Bulk answering via the queue, plus file upload / import.
- A **confidence** signal per answer (low-confidence rows are flagged).
- Per-row **Approve** — but Magpie's approval means *"admit this answer into the reuse
  corpus"*, not *"I'm accountable for this"*.
- Export to `.md` / `.csv`.

Hot Potato adds the **people** layer: ownership, sign-off, chasing, final sign-off, audit.
Keep *sign-off* (Hot Potato) and *approval* (Magpie) separate; a signed-off row can then
approve the answer in Magpie so it becomes reusable.

## Key design points

- **Auto-assign owners** by topic (e.g. encryption → Infra lead). Manual assignment of
  300 rows won't happen.
- **One named person per row**, never a team. Owners can sign off, edit then sign off,
  or reassign with a reason — but not ignore it.
- **Due dates + escalation** — overdue rows go to the owner's manager or the document
  owner. Without this, people ignore it in a fancier way.
- **Final sign-off is locked** until every row is signed off. Any override needs a
  written reason and is logged.
- **Append-only audit trail** — who, what, when, answer before/after. Exported with the
  document.
- **Write answers back into the original file**, and let owners flag *"answer is in the
  wrong place"* — that's where messy source documents hurt most.
- **Low-confidence rows first**, so reviewer effort goes where Magpie is weakest.
- **Fight rubber-stamping** — show each answer's sources and confidence next to the
  sign-off button.

**MVP:** upload → Magpie fills → auto-assign → per-row sign-off → final sign-off →
audit log → export in the original format. Due dates/escalation come next.

## How to host it

### Option A — a Claude shared artifact (cheapest way to try it)

Claude artifacts can already cover most of this:

| Need | Artifact feature |
|---|---|
| Upload the questionnaire | File upload, parsed in the browser |
| Make sense of a messy document | Ask Claude which cells are questions / answers |
| Get answers from Magpie | Call the Magpie connector as the viewer |
| Know who's who, assign owners | Viewer identity + org people search |
| Per-row and final sign-off | Shared database with rules so **only you can write your own sign-off** — not even the artifact owner can fake it |
| Audit trail | Append-only log rows |
| Export | Download button |

#### How it would flow

1. **Upload.** User A uploads the questionnaire. The original file is visible to
   artifact editors only (by default). The parsed questions/answers go into the shared
   database, visible to whoever the artifact is shared with — rules can narrow that,
   down to "each owner sees only their own rows".
2. **Fill.** Runs **in the page, in User A's browser**, through User A's Magpie
   connector. Magpie is queue-based, so answers drip in; Magpie keeps the questionnaire,
   so if A closes the page it picks up where it left off on the next open.
3. **Assign.** Also **in the page** — no separate agent. An **owner map** (topic →
   person, plus their email) lives in the shared database. The page asks Claude (running
   as User A) to tag each row with a topic, then looks up the owner. **User A reviews and
   fixes the assignments before they go out** — a bad assignment is how rows get ignored.
4. **Sign off.** Each owner opens the page, sees their rows, and signs off / edits /
   reassigns with a reason. Final sign-off unlocks when every row is done.
5. **Chase + back up.** A **daily Claude scheduled task** (outside the page):
   - reads the shared data, emails/Slacks owners of unsigned or overdue rows, and
     escalates the late ones;
   - commits a snapshot of the data and audit log to a **Git repo**.

   Messages and commits come from the account of whoever set up the task. The task needs
   owners' emails, so they live in the owner map (the page itself only stores opaque user
   ids).

#### Where the data lives

| What | Where | Who can see it |
|---|---|---|
| The page | Claude, as artifact versions | Anyone it's shared with |
| Rows, owners, sign-offs, audit log | Claude's per-artifact database (survives page updates) | Per the rules |
| Uploaded files | Claude's per-artifact file store (≤20 MB each; some overall quota — size unknown) | Editors by default |
| Per-person settings | The viewer's browser | Only them |
| Snapshots / audit history | Our Git repo, via the scheduled task | Repo access |

So apart from the Git snapshots, everything sits on Anthropic's side, scoped to that
artifact in our Claude org. Magpie's data stays in Magpie; the artifact holds copies of
answers. **Check before using:** security questionnaires describe our security posture,
so confirm storing them in Claude fits our policies (region, retention, encryption —
see Anthropic's trust/privacy docs or our Claude admin).

#### Limits

1. **Database rules aren't encryption.** The artifact owner or an editor can later loosen
   the rules or change the code, then read or edit anything, and nobody is told. The Git
   snapshots soften this: a later quiet edit shows up as a diff in the next snapshot.
   They won't catch a change made and reverted between snapshots.
2. **Git proves *when*, not *who*.** Snapshot commits come from the task owner's account;
   *who* signed still rests on Claude's identity check.
3. **Whoever fills needs the Magpie connector set up.**
4. **Org-only.** Outside guests get limited access.

### Option B — a hosted app

A small separate service calling Magpie's API.

| | Artifact | Hosted app |
|---|---|---|
| Time to first version | Days | Weeks |
| Running cost / upkeep | Near zero | Hosting, auth, DB, updates |
| Who can use it | Our org's Claude users | Anyone, incl. outside reviewers |
| Login | Free, via Claude | Build or plug in SSO |
| Trustworthy audit | Weak (Git snapshots help) | Strong — we control it, can make it immutable |
| Reminders / escalation | Via a daily Claude scheduled task | Built in |
| Magpie access | Each filler needs the connector | One service account |
| Where data lives | Claude (+ our Git) | Wherever we choose |

### Suggestion

1. Try the artifact on one or two real questionnaires.
2. If people use it, add the daily scheduled task (reminders + Git snapshots).
3. Go hosted only if outside reviewers or formal, customer-facing audit become a real
   need.

**Deciding question:** is the sign-off record only for us internally, or will we ever
show it to a customer or auditor? Internal → artifact. External → hosted.
