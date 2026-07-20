---
name: write-a-product-spec
description: Create or update a living **product spec** in `docs/` for Markdown Magpie — the authoritative, as-built specification of a subsystem (`docs/retrieval.md`, `docs/proposals-and-publishing.md`, …), NOT the dated design archive in `docs/superpowers/specs/`. Use whenever the user wants to write, refresh, extend, or correct a spec; document a subsystem "as built"; capture how something *currently* behaves; or change intended behaviour spec-first. Also use after building or changing a feature when the matching `docs/*.md` spec needs to keep up. Covers the clause-ID + code-map + provenance convention, the verify-against-code discipline, and updating the `docs/README.md` index.
---

# Writing a Markdown Magpie product spec

The `docs/*.md` files are the **living specification** — the source of truth for how the
system behaves, and the thing you change *first* when you want behaviour to change:

> **Edit the spec → an agent (or a human) makes the code match → the tests pin it.**

They are not the same as `docs/superpowers/specs/` — that directory is **design history**
(dated `YYYY-MM-DD-*-design.md`, future-tense, PR-anchored, and *accreting*: a subsystem
often has 3–4 overlapping design docs you must read as a chain to find the end state). A
product spec **cites** design docs as provenance; it never defers to them for "how it
behaves now". Read `docs/README.md` (the index + `## Conventions`) and `docs/retrieval.md`
(the reference exemplar) before writing — don't re-derive the shape from memory.

## The one rule everything else serves

**An untagged clause is a claim about *current* behaviour, and it must be true.** These
specs are only worth trusting if "as-built" and "as-written" are identical. So the work is
never "write plausible prose about the subsystem" — it is "verify each claim against the
code, then write it down". Memory and design docs are leads, not evidence. When you assert
something, you should be able to point at the file that makes it true.

If you need to describe behaviour the code does **not** yet satisfy (spec-first change, or
a known gap), that is allowed — but the clause MUST be tagged `> ⚠️ NOT YET IMPLEMENTED`
with a one-line note, so the gap is explicit and trackable. No silent aspiration.

## Two modes

- **Document as-built** (the common case): a subsystem exists and the spec should describe
  it accurately. Gather facts from code, then write. Drift you find between the old
  doc/design docs and the code is a *valuable output* — flag it, don't paper over it.
- **Spec-first change**: the user wants new behaviour. Edit the spec to define it, tag the
  new/changed clauses `⚠️ NOT YET IMPLEMENTED`, and that spec becomes the brief the code
  change is then written against (often via the `add-a-job-type` / `write-a-migration` /
  `writing-magpie-tests` skills). Drop the tag when the code lands.

## Workflow

### 1. Locate the target

Find the subsystem's row in the `docs/README.md` spec-set table — that names the spec file
and its primary code area. Creating a new spec? Add a row. One spec is authoritative for
**one code area**; if the topic spans several, it's probably a *pipeline* spec (like
`architecture.md`) that delegates detail to subsystem specs rather than duplicating them.

### 2. Gather as-built facts from code

This is the bulk of the work and where accuracy is won or lost.

- For a **small or familiar** area, read the code directly (`Grep`/`Read`) and note the
  `file:line` behind each claim as you go.
- For a **large or unfamiliar** subsystem, **fan out subagents** (`Explore`, or
  `general-purpose` when it should also draft) to build a code-grounded fact list — one
  agent per sub-area, run concurrently. This keeps whole-file dumps out of your context
  and is dramatically faster. Give each agent: the exact sub-area, "return a structured
  fact list, every claim with `file:line`", the instruction to **verify the design docs'
  END state against the code and flag stale claims**, and a pointer to `retrieval.md` for
  the target shape. (Background agents occasionally stall — if an output file sits at its
  launch stub with no progress, relaunch that one rather than waiting.)
- Treat the accreting design docs as leads to confirm, never as truth. The whole point of
  a living spec is that it collapses that chain into the one current answer.

### 3. Write (or update) the spec

Follow the shared shape exactly — a change to one clause should map cleanly to one area of
code:

- **Status header** — a short `> **Status:** living spec (as-built).` block, 1–3 lines,
  like the exemplars.
- **`## Purpose`** — a few sentences on what the subsystem is for.
- **Numbered normative clauses** with a **stable, unique per-spec prefix** (`R1`, `R2`, …
  for retrieval; `G`, `P`, `S`, `Q`, `AZ`, `TM`, … pick a short prefix not already in use).
  Present-tense, using MUST / MUST NOT / SHOULD / MAY in the RFC-2119 sense. Explain *why*
  a rule exists where it isn't obvious — a reader who understands the reason maintains it
  correctly. Reference tables (endpoint catalogs, config tables, job tables) are fine; keep
  them as tables and number the behavioural rules around them rather than numbering every
  row.
- **`## Code map`** — a table (concern → implementing `file`/dir), so "edit spec → change
  code" has an unambiguous target. Verify every path exists.
- **`## Tests (behavioural contract)`** — the `*.test.ts` files that pin the behaviour
  (verify they exist).
- **`## Provenance (design history)`** — link the `docs/superpowers/specs/*-design.md`
  docs this consolidates, and note which are superseded/stale. This is the "why".
- **Gap markers** — tag any not-yet-true clause `⚠️ NOT YET IMPLEMENTED`; add a `⚠️` note
  where you corrected drift, so the correction is visible rather than silent.

### 4. Updating an existing spec — never break references

Clause IDs are external anchors (tests, PRs, and other specs cite `retrieval.md#R4`). So:
**never renumber an existing clause.** Append new ones at the end of their section, and
retire an obsolete one by striking it (`~~R7~~ *withdrawn*`) rather than deleting or
reusing its number. This keeps every outside reference valid.

### 5. Update the index

Edit `docs/README.md`: link the spec from the spec-set table (drop any `*(planned)*`
marker), and tick/append the migration checklist if the change belongs there. A spec that
exists but isn't linked from the index is effectively invisible.

### 6. Validate and ship

- **Prettier gates markdown** — CI's `format:check` (part of `npm run verify`) will fail on
  an unformatted doc. Run `npx prettier --check docs/<file>.md docs/README.md` and fix
  before committing (`npx prettier --write …`).
- **Commit and push little and often** with a descriptive message; open a PR. Batching many
  specs into one PR is fine when the user prefers it, but each commit should be coherent.
- Per the repo's non-negotiables, update the spec **alongside** the code change it
  describes, not as an afterthought.

## What "good" looks like

A reviewer can take any single clause, follow the code-map row to the file, and confirm the
clause is true — or find it's a tagged gap. The spec reads as the current answer to "how
does this behave now", with the design-doc chain collapsed into it and cited for "why". No
clause is aspirational without a `⚠️` tag; no external clause reference has rotted.
