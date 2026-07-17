# Presentation refresh — real live-stack screenshots + new functionality

**Date:** 2026-07-17
**Status:** design approved, pending spec review
**Related:** [`2026-06-17-magpie-pitch-deck-design.md`](2026-06-17-magpie-pitch-deck-design.md) (the original deck design)

## Problem

The pitch deck (`presentation/`, built by `scripts/build-deck.mjs`) was assembled in June
2026 and has drifted from the current product:

- Slides 5–7 use **synthetic** UI shots — fixture HTML rendered with the app's real CSS by
  `scripts/render-static-ui-shots.mjs`. The console has since grown from 10 to 15 sections
  (added Seed, Questionnaires, Source Map, Activity, Insights, Schedules) and the panels
  themselves have evolved, so the synthetic shots no longer match what a viewer sees.
- Several shipped features are absent: **multi-turn Ask** (#239), **prompt-injection
  hardening** (#291) + **per-tool MCP scope on batches** (#279), and the entire
  **Questionnaires** feature (web panel + `kb_questionnaire_*` MCP tools), which currently
  appears only as one row in the applications table.
- The demo (slides 8–11) is real but FlowerBI-era; the MCP tool list on slide 8 is stale
  (`kb_ask`, `kb_search`, `kb_feedback`) versus today's larger surface.

There is now a live, populated deployment at `magpie.wastedcake.com` (demo account,
already authenticated in the browser pane) with three flows — **FlowerBI KB** (`flowerbi`),
**Magpie Sales** (`magpie-sales`), **Magpie Support** (`magpie-support`) — 8 gap clusters,
7 proposals (some `pr-opened`), real "Sales QA" questionnaire runs, and a hosted MCP server
at `mcp-magpie.wastedcake.com/mcp` (OAuth). This is the capture source.

## Goals

1. Replace the synthetic slide 5–7 shots with **real captures** from the live console.
2. **Weave in** the new small features (multi-turn Ask, injection-hardening) as copy on the
   existing lie/leak slides.
3. Add **one** dedicated **Questionnaires** slide with real captures.
4. **Re-stage and re-capture** the demo story (slides 8–11) against the live instance, with
   Part 1 ("in Claude") re-skinned as a styled transcript built from real `kb_ask` data.
5. Keep the narrative spine unchanged: *won't lie · leak · rot → cheap & yours*. Target ~16
   slides.

Non-goals: no "what's new" section, no restructure of the spine, no new console features.

## Design

### Capture inventory (all real, 1440px viewport)

| Slide | Asset key | Source | Notes |
|---|---|---|---|
| 5 · Won't lie | `05-ask` (new) | Live **Ask** | Fresh clean question → HIGH-confidence cited answer with "How this was answered" expanded. Avoid the low-confidence backlog in the answered list. |
| 6 · Won't leak | `06-proposal` (new) | Live **Proposals** | A proposal in `pr-opened` state showing target path, rationale, Markdown, and review actions. |
| 7 · Won't rot | `07-gaps` (new) | Live **Gaps** | Suggested-cluster view (real FlowerBI/Magpie clusters). |
| NEW · Questionnaires | `qn-panel` (new) | Live **Questionnaires** | Create form + completed "Sales QA" runs (reuse stats, `complete`) + one generated answer with a `changed`/`reused` badge. |
| 9 · Demo detect+draft | `web-gap-cluster`, `web-proposal` (re-shoot) | Live Gaps + Proposals | Same two-frame layout, refreshed. |
| 10 · Demo review+ship | `web-raised-prs`, `web-merged-in` (re-shoot) | GitHub PR + live console | Raised PR view + merged/re-indexed console. |
| 11 · Demo payoff | `mcp-result-of-learning` (re-shoot) | Live Ask (re-ask) | The previously-uncovered question now answered. |

Curation: the demo instance's answered list is full of deliberate low-confidence answers.
Hero/product shots must be staged with fresh, well-covered questions so the "grounded"
slides actually look grounded.

### Slide 8 — Part 1 re-skin (styled transcript, not a screenshot)

`build-deck.mjs` already ships unused `.chat` / `.badge` transcript CSS. Slide 8 will use it:
run `kb_ask` via this session's MCP tools against `magpie-sales`/`magpie-support`, capture
the **real** question, answer text, confidence, and citation paths, and render them into two
transcript cards — one HIGH (covered) and one LOW (gap). This removes the two
`mcp-high-confidence` / `mcp-low-confidence-*` bitmaps from that slide in favour of crisp,
real, in-deck text. The `assets/example/mcp-*.jpg` files are retired from the build.

### Copy changes

- **Slide 5 (lie):** add a fourth `feat` point — *Multi-turn conversation* — "ask a
  follow-up and it keeps the thread and its citations."
- **Slide 6 (leak):** add a point on *prompt-injection hardening* — untrusted source material
  is delimited before it reaches the model, and MCP tokens are scoped per-tool (incl. on
  JSON-RPC batches).
- **Slide 8 footnote:** update the MCP tool list to the current surface (`kb_ask`,
  `kb_search`, `kb_citation`, `kb_flows`, `kb_outline`, `kb_seed`, `kb_questionnaire_*`) and
  note the hosted OAuth MCP endpoint.
- **Slide 13 (applications):** the "security questionnaires" row is now a shipped feature, not
  a hypothetical — keep the row but it's reinforced by the new Questionnaires slide.

### New Questionnaires slide

Placement: after the demo payoff (slide 11) and before "Cheap & yours", as a "and it does
whole workflows, not just single answers" beat. Ink or light background consistent with
neighbours. Layout: short left rail (what a questionnaire run is: batch of questions →
grounded, cited, reused answers → export) + a real capture of the Questionnaires panel.

### Build / pipeline

- Real captures for slides 5–7 + Questionnaires are downscaled through the existing
  `assets/` → `assets/opt/` JPEG path (they are UI shots, not text-dense) via
  `scripts/optimize-assets.py`. Demo re-shoots keep their native-resolution path in
  `assets/example/`.
- `scripts/render-static-ui-shots.mjs` / `shoot.mjs` are no longer the source for any shown
  slide. Leave the scripts in place (harmless) but update `presentation/README.md` to state
  that shown product shots are now **real live-console captures**, and document the capture
  procedure (log into the deployment, 1440px viewport, which screen per slide).
- Rebuild with `node scripts/build-deck.mjs`; verify with `node scripts/verify-deck.mjs`.
  Confirm the committed copy at `apps/web/public/presentation/index.html` is regenerated
  (it is what the app serves).

### Slide count / numbering

15 → 16. The hardcoded HUD default `1 / 13` (already wrong; JS overwrites it) will be left
or corrected to `1 / 16`. The overview grid and counter derive from the DOM, so no JS change
needed beyond the copy.

## Risks / open points

- **Demo re-staging writes to the live instance** (drafts, jobs, real GitHub PRs, merges).
  The user has authorised full freedom on the demo site. Actions will still be reported as
  they happen.
- **PR raise/merge depends on the destination repo wiring** of the live instance; if raising
  a fresh PR isn't reproducible, reuse the existing `pr-opened` proposal already present
  (`Competitive Win/Loss Intelligence…`) for the slide-10 PR frame.
- Real screenshots carry real data — every captured screen must be eyeballed for anything
  that shouldn't ship in a pitch deck before it's inlined.

## Verification

- `node scripts/build-deck.mjs` succeeds and reports 16 slides.
- `node scripts/verify-deck.mjs` renders every slide without error.
- Manual eyeball of the rebuilt deck (open `presentation/index.html`): each refreshed slide
  shows the new real capture, new copy points present, Questionnaires slide reads well, the
  Part-1 transcript shows real Q/A/citations.
- `apps/web/public/presentation/index.html` regenerated and byte-identical to the root copy.
