---
name: magpie-questionnaires
description: Run a batch of questions through a Markdown Magpie knowledge base as a questionnaire — creating it with kb_questionnaire_create, polling the worksheet with kb_questionnaire_get, and approving answers into the reuse corpus with kb_questionnaire_approve. Use for security questionnaires, RFP/DDQ response sets, audit checklists, or any list of questions answered against one flow.
---

# Magpie questionnaires

A questionnaire is a **named batch of questions answered against one flow**, with verbatim
reuse of previously approved answers while the sections they cited are unchanged. It is the
right tool for security questionnaires, RFPs, DDQs and audit checklists — anywhere the same
questions come round again and consistency between rounds matters.

Use it instead of looping `kb_ask` over a list: looping loses the reuse corpus, the
worksheet, and the approval gate.

## The loop

```
kb_questionnaire_create { name, flow, questions[1..500], direction? }  → initial worksheet
kb_questionnaire_get    { questionnaire }                             → poll until settled
kb_questionnaire_approve{ questionnaire, item? }                      → into the reuse corpus
```

### Create

- `questions` is **one question per entry**, 1–500 of them. Keep the source document's
  wording; that wording is what matches against previously approved answers.
- `flow` comes from `kb_flows`. One questionnaire, one flow.
- **`direction` (≤2000 chars) is set once and can never be changed.** It says how ambiguous
  questions should be *read* — e.g. *"where ambiguous, assume the question is about the
  company and not the product"*. It steers interpretation and framing only; it can never
  widen what may be claimed. It applies to every item, including ones that would otherwise
  be inherited verbatim. Because it is immutable, confirm the wording with the user before
  creating rather than after.

### Poll

Creation is **asynchronous by design** and never waits. The tool returns the worksheet
immediately: items the deterministic fast-path already confirmed reusable carry answers
straight away; everything else drips through the answering queue.

Re-read with `kb_questionnaire_get` until no item is `pending` or `answering`. Reading also
**resumes a stalled drip** server-side, so a poll is never wasted. Space polls sensibly —
a 500-item questionnaire takes a while.

### Read the worksheet

Each item carries `status`, and once answered an `outcome`:

| `outcome` | Means | Review weight |
| --- | --- | --- |
| `reused` | Verbatim from an approved answer, citations unchanged | Light — bulk-approvable |
| `adapted` / `merged` | Built from prior approved answers | Read it |
| `fresh` | Newly generated | Read it properly |

`confidence` is a review badge, not a suppressor — a `low` item still has an answer, and
still needs a human's eye. `changeReason` explains why a previously-reused answer stopped
being reusable (`section_changed`, `section_missing`, `new_content`). `unanswerable` items
are the honest ones: the knowledge isn't there. Surface them as gaps rather than papering
over them.

### Approve

Approval is the act that makes an answer **reusable verbatim next time** — it writes into
the match corpus, so it shapes future questionnaires.

- `{questionnaire}` alone bulk-approves **all reused items** and returns `{approved: n}`.
  That is the safe bulk move: those answers were approved before and their citations
  haven't moved.
- `{questionnaire, item}` approves one answered item.
- The API returns **409** unless the item's status is `answered` — a `pending`/`answering`
  item isn't ready; poll again rather than retrying the approve.

**Never bulk-approve fresh, adapted or merged answers on the user's behalf.** They are new
claims entering the corpus, they need `manage:knowledge` scope for a reason, and a wrong
answer approved once gets reused verbatim for as long as its citations hold.

## Failure modes

- **Items stuck `pending` forever** — the answering queue isn't being processed (no
  watcher). Report it; `kb_questionnaire_get` resumes a stalled drip but cannot conjure a
  worker.
- **403 on approve** — approving needs `manage:knowledge`, above the `ask:knowledge` needed
  to create. That gate is intentional.
