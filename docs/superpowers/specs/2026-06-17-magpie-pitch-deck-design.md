# Markdown Magpie — Pitch Deck Design

**Date:** 2026-06-17
**Author:** Adam Awan (with Claude)
**Status:** Built — `presentation/index.html` (13 slides, self-contained, real screenshots from a live FlowerBI KB). Logo uses `icon.jpeg`.

## Context

Adam built Markdown Magpie to solve knowledge gathering and sharing. Several earlier
attempts at the company were "basic knowledge dumps". Magpie is different because it is
grounded in real source material, every answer is cited, knowledge is curated through
review, and it self-improves and self-prunes. Crucially, end users never see the raw
material (code, internal docs, restricted folders) — they get a governed knowledge layer
on top, where an admin approves PRs.

This deliverable is an **HTML/JS keyboard-navigated slide deck** to present the app to
colleagues and win buy-in to pilot it.

- **Audience:** decision-makers who are all technically strong and enthusiastic about AI.
- **Goal:** get buy-in by showing how impressive and principled the design is — without
  belittling earlier attempts (frame the failure modes as a shared, hard problem).
- **Format:** keyboard slide deck (arrow keys), presented live.
- **Demo:** live demo plus embedded real screenshots. Show it working **from inside Claude
  via the MCP tools** (`kb_ask`), then the **backend curation flow** (gap → cluster →
  proposal → PR → merge → reindex) in the web console.

## The Sharpened Pitch

Reframe the five raw selling points into a memorable spine — **"Won't lie, won't leak,
won't rot"** — which maps directly onto why ordinary internal KBs fail:

- **Won't lie** — every answer cites file + heading + commit, logs confidence, and abstains
  when unsure. Grounded by construction, not "an LLM that's usually right".
- **Won't leak** — raw material never reaches end users; they get a curated lens. Every
  change is a reviewed Git PR with full audit history. This is what makes it safe on
  sensitive corpora.
- **Won't rot** — it finds its own gaps (clusters failed/low-confidence questions), drafts
  fixes, raises PRs; Crunch consolidates, de-dupes, and flags contradictions. Usage is the
  maintenance signal.
- **Kicker — cheap & yours** — vendor-neutral (no model lock-in), MCP-native (knowledge
  inside the tools people already use), runs on infra / Claude Code subscriptions already
  paid for, and the KB is just Markdown + Git (portable, forkable, no black box).

## Slide Flow (~12 slides)

1. **Title** — "Knowledge that won't lie, leak, or rot."
2. **The problem** — knowledge sharing fails three ways: KBs go stale, over-share, or
   confidently make things up. Framed as a shared, hard problem.
3. **The insight** — stop dumping knowledge; separate *raw material* from a *curated,
   cited, living layer* on top.
4. **Three promises** — the spine slide (three cards).
5. **Won't lie** — cited answers + confidence + abstain → real cited-answer screenshot.
6. **Won't leak** — raw stays hidden; PR review; audit; governance → diagram + PR screenshot.
7. **Won't rot** — the flywheel (gap → cluster → draft → PR → merge → reindex) + Crunch →
   gaps UI screenshot.
8. **Live demo** — "Watch it from inside Claude": `kb_ask` via MCP, then the backend flow.
   Embedded real screenshots as fallback.
9. **Cheap & yours** — vendor-neutral, MCP-native, BYO-agent/subscription, Markdown + Git.
10. **Wide applications** — source→output matrix (NXG→product Qs; NXG+Azure+policies→
    security questionnaires; NXG+Minerva→support; Product Vault→refined).
11. **Easy to set up** — point it at a repo; the loop does the rest.
12. **Call to action** — pick one pilot corpus and let it run.

## Visual Style

- Reuse the existing console palette: ink `#17211d`, accent teal `#285f74`, accent-soft
  `#e5f1f4`, wash `#f5f7f2`, paper `#fff`, ok/warn/bad greens/oranges/reds. Inter font.
- Calm "paper" aesthetic with a teal accent; 16:9 slides; large type; generous whitespace.
- Logo: `icon.jpeg` (perched magpie). Knock out / mask onto a roundel for dark surfaces and
  favicon as needed.

## Technical Approach

- **Single self-contained HTML file** with vanilla JS for keyboard navigation (←/→, Home,
  End, and a slide counter). No framework/build step — matches "html/js presentation" and
  is trivially shareable.
- **Inline assets as base64** (logo + screenshots) so the final file is one portable
  artifact a colleague can open from a link or attachment with no server.
- Location: `presentation/index.html` (assets inlined). Speaker-friendly: optional `?print`
  or `s` key for a speaker/overview later if wanted (YAGNI for v1).

## Assets To Capture (from the running stack)

Run the stack locally (per the `run-magpie` skill), seed the bundled `cats` KB, then capture:

1. A **cited answer** in the web console (or via `/api/ask`) — for slide 5.
2. The **gaps / review queue** UI — for slide 7.
3. A **proposal / pull request** view — for slides 6 & 8.
4. **MCP `kb_ask` from inside Claude** — real tool call + cited response — for slide 8.

Screenshots saved under `presentation/assets/` then inlined into the final HTML.

## Out of Scope (v1)

- No speaker-notes mode, no PDF export pipeline, no transitions library, no remote hosting.
- No changes to the application itself.
