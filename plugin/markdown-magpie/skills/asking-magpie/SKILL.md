---
name: asking-magpie
description: Get cited answers out of a Markdown Magpie knowledge base — choosing between kb_ask and kb_search, pinning a flow, threading follow-ups, pulling full citation text, and reporting gaps. Use whenever a question should be answered from the organisation's indexed Markdown knowledge rather than from the model's own memory or the local repo.
---

# Asking Markdown Magpie

Magpie answers questions from an **indexed Markdown knowledge base**, always with
citations back to the source sections. The `kb_*` tools come from the `markdown-magpie`
MCP server shipped with this plugin.

## Pick the right tool

| You want | Use |
| --- | --- |
| A written answer to a real question, with citations | `kb_ask` |
| To find which sections mention a term | `kb_search` |
| The full text behind a citation you were given | `kb_citation` |
| The list of knowledge areas you can ask against | `kb_flows` |

`kb_search` is keyword matching over indexed sections — it is cheap and immediate, but it
returns *sections*, not an answer. `kb_ask` is a queued generative job and takes real time
(tens of seconds is normal). Don't loop `kb_ask` when you actually want to grep.

## Asking well

1. **Ask one question per call.** Magpie routes and cites per question; a compound
   question produces a muddled answer with citations you can't attribute.
2. **Ask it in full sentences,** as a person would. The question text is what gets
   retrieved against and what gets logged for reuse — `"pricing?"` retrieves badly.
3. **Let the router pick the flow** by default. Only pass `flow` when you already know the
   area (ids come from `kb_flows`) or when a previous call came back with
   `flowSelectionRequired` — that response lists the candidate flows, and you re-ask with
   one of their ids.
4. **Thread follow-ups with `conversationId`.** Every `kb_ask` result returns one. Pass it
   back and pronouns and ellipsis resolve against the earlier turns and stay in the same
   flow; omit it and you start a fresh conversation. Follow-ups are how you drill in — don't
   re-state the whole context in a new question.

## Reading the answer

The result is `{answer, confidence, citations, gaps?, questionId, conversationId}`.

- **Report the answer with its citations.** Each citation carries `path`, `heading` and an
  `excerpt`. When you relay a Magpie answer to the user, relay where it came from — an
  uncited Magpie answer is indistinguishable from you making it up.
- **`confidence` is a review badge, not a filter.** `low` means say so, not suppress.
- **`gaps`** appear when the answer exposed missing knowledge. Surface them; they are the
  input to seeding new documents (see the `seeding-a-flow` skill).
- **Need more than the excerpt?** Pass up to 20 `sectionId`s to `kb_citation` for the
  currently-indexed full text. Ids that no longer resolve come back in `missing` rather
  than erroring — the knowledge base moved on, so re-ask or `kb_search`.

## Closing the loop

`kb_feedback` takes `{questionId, kind, gapSummary?}` with `kind` one of `helpful`,
`unhelpful`, `knowledge_gap`.

- Send `helpful`/`unhelpful` when the user reacts to an answer you relayed.
- Send `knowledge_gap` with a one-line `gapSummary` whenever the answer was thin *because
  the knowledge isn't there* — this feeds the same gap-candidate clustering as automatic
  detection, and is how the KB learns what it's missing. It is independent of
  helpful/unhelpful: a helpful answer can still expose a gap.

Only report feedback you actually have grounds for. Don't auto-fire `helpful` on every
answer — an inflated corpus is worse than a quiet one.

## Failure modes

- **`kb_ask` times out** — answering is a queued job; a Magpie deployment with no watcher
  running never completes one. Say the job timed out rather than retrying in a loop.
- **Everything 401s** — the server is an OAuth-protected resource; re-authenticate the MCP
  connection rather than working around it.
- **403 on a specific tool** — your token lacks that tool's scope (`ask:knowledge` for
  `kb_ask`, `read:knowledge` for search/flows/citations, `feedback:questions` for
  feedback). That is a permissions decision, not a bug to route around.
