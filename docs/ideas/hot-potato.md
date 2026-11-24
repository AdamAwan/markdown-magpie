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

Limits:

1. **Audit isn't tamper-proof.** The artifact owner or an editor can later change the
   rules or code and quietly edit history. Fine for internal accountability; weak as
   evidence for an external auditor.
2. **No chasing on its own.** A page can't send reminders. A Claude scheduled task could
   check daily and email people, but that's extra work.
3. **Everyone filling needs the Magpie connector set up**, since answers come from
   whoever runs the fill.
4. **Org-only.** Outside guests get limited access.

### Option B — a hosted app

A small separate service calling Magpie's API. Gives a proper tamper-evident audit log,
reminders/escalation, and outside reviewers — at the cost of building and running it.

**Suggestion:** start with the artifact on one real questionnaire and see whether people
actually sign off. Build the hosted version only if it sticks.
