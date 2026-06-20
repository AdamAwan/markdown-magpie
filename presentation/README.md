# Markdown Magpie — Pitch Deck

A self-contained, keyboard-navigated HTML slide deck pitching Markdown Magpie to
colleagues. The narrative spine is **"won't lie · won't leak · won't rot"** plus a
"cheap & yours" close. Design spec:
[`docs/superpowers/specs/2026-06-17-magpie-pitch-deck-design.md`](../docs/superpowers/specs/2026-06-17-magpie-pitch-deck-design.md).

## Viewing / presenting

Open **`presentation/index.html`** in any browser — no server, no build, no
dependencies. Every image is inlined as base64, so the single file is the whole deck
(≈1.7 MB); you can email it or drop it on any static host.

Keyboard:

| Key | Action |
| --- | --- |
| `→` / `Space` / `PageDown` | next slide |
| `←` / `PageUp` | previous slide |
| `Home` / `End` | first / last slide |
| `O` | overview grid (click a slide to jump) |
| `F` | fullscreen |
| click right / left third | next / previous |

The URL hash tracks the slide (e.g. `index.html#8`) for deep links.

## The demo (slides 8–11)

The demo is a three-act story told in real screenshots — no live stack required:

1. **In Claude** (slide 8) — `kb_ask` answers a covered question with **HIGH** confidence,
   then abstains on a missing one and flags it as a gap (**LOW**).
2. **Backstage** (slides 9–10) — the gap is clustered and a fix is drafted (slide 9), then
   the change is raised as a PR, reviewed, merged & re-indexed (slide 10).
3. **The payoff** (slide 11) — the same question that drew a blank now returns a complete,
   grounded answer.

The screenshots are real captures from a live FlowerBI knowledge base and live in
`assets/example/`. To capture fresh ones, run the stack locally (see the `run-magpie`
project skill) and replace the files in that folder, keeping the same names.

## Rebuilding

Content and styles live in `scripts/build-deck.mjs`. Screenshots come from two places,
both inlined as base64 so the deck stays a single self-contained file:

- `assets/` (raw) → `assets/opt/` (downscaled JPEGs) — the product UI shots on slides 5–7.
- `assets/example/` — the demo screenshots on slides 8–11, inlined at native
  format/resolution (they are text-heavy and must stay legible, so they skip the JPEG
  downscale step).

```bash
# 1. (re)capture console screenshots from a running stack on :3000
node scripts/shoot.mjs
node scripts/shoot2.mjs
# 2. downscale + recompress for inlining
python3 scripts/optimize-assets.py
# 3. assemble the single-file deck
node scripts/build-deck.mjs
# 4. (optional) render every slide to PNG to eyeball it
node scripts/verify-deck.mjs
```
