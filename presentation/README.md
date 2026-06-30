# Markdown Magpie — Pitch Deck

A self-contained, keyboard-navigated HTML slide deck pitching Markdown Magpie to
colleagues. The narrative spine is **"won't lie · won't leak · won't rot"** plus a
"cheap & yours" close. Design spec:
[`docs/superpowers/specs/2026-06-17-magpie-pitch-deck-design.md`](../docs/superpowers/specs/2026-06-17-magpie-pitch-deck-design.md).

## Viewing / presenting

The deck is generated. The **committed** copy lives at
`apps/web/public/presentation/index.html` — it ships in the Docker image (which
never runs the build) and is what the running app serves at `/presentation/index.html`.

For a standalone copy to open directly, email, or drop on a static host, build it
once with `node scripts/build-deck.mjs`; that (re)writes both the root
`presentation/index.html` (git-ignored) and the served copy above. Every image is
inlined as base64, so the single file is the whole deck (≈1.7 MB) — no server, no
dependencies.

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
# 1. (re)capture static console screenshots
node scripts/shoot.mjs
# 2. downscale + recompress for inlining
python3 scripts/optimize-assets.py
# 3. assemble the single-file deck
node scripts/build-deck.mjs
# 4. (optional) render every slide to PNG to eyeball it
node scripts/verify-deck.mjs
```
