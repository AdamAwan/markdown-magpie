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

## The live demo (slide 8–9)

Slide 8 is the cue to switch to a real `kb_ask` call from inside Claude via the MCP
server; slide 9 is the backstage curation flow. To run the stack locally for the demo,
see the `run-magpie` project skill. The embedded screenshots are real captures from a
live FlowerBI knowledge base and serve as the fallback if the live demo can't run.

> The session's MCP tool reads `apps/mcp/dist/`. If `kb_ask` 404s, rebuild it
> (`npm run build -w @magpie/mcp`) and reconnect the MCP server (`/mcp` → reconnect, or
> restart the client) so it picks up the new build.

## Rebuilding

Content and styles live in `scripts/build-deck.mjs`; screenshots live in
`assets/` (raw) and `assets/opt/` (downscaled JPEGs that get inlined).

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
