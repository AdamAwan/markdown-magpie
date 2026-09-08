# Markdown Magpie — Pitch Deck

A self-contained, keyboard-navigated HTML slide deck pitching Markdown Magpie to
colleagues. The narrative spine is **"won't lie · won't leak · won't rot"** plus a
"cheap & yours" close. 18 slides, ending on where else the engine can be pointed. Design spec:
[`docs/superpowers/specs/2026-06-17-magpie-pitch-deck-design.md`](../docs/superpowers/specs/2026-06-17-magpie-pitch-deck-design.md).

## Viewing / presenting

The deck is generated. The **committed** copy lives at
`apps/web/public/presentation/index.html` — it ships in the Docker image (which
never runs the build) and is what the running app serves at `/presentation/index.html`.

For a standalone copy to open directly, email, or drop on a static host, build it
once with `node scripts/build-deck.mjs`; that (re)writes both the root
`presentation/index.html` (git-ignored) and the served copy above. Every image is
inlined as base64, so the single file is the whole deck (≈2.3 MB) — no server, no
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

## The demo (slides 10–13)

A single scenario, followed end to end — no live stack required. A user asks Magpie's Sales
KB whether it supports **single sign-on**; the KB doesn't cover it yet, so the loop fills the
gap and the same question is answered on re-ask.

1. **In Claude** (slide 10) — a Claude Desktop window mock-up (typeset in the deck, not
   screenshotted) carrying one thread of two `kb_ask` calls: a covered question answered
   with **HIGH** confidence and citations, and the SSO question the engine abstains on and
   flags as a gap (**LOW**). The `markdown-magpie` MCP connector sits in its sidebar.
2. **Backstage** (slides 11–12) — the SSO gap is clustered, the configured sources are read,
   and a page is drafted (slide 11), then raised as a PR, reviewed, merged & re-indexed
   (slide 12). Slide 11's middle column is typeset in the deck rather than screenshotted: it
   names the four source kinds (`git`, `local`, `internet`, `agent`) a draft can pull from,
   making the point that sources are read **at draft time** and never indexed as the answer
   corpus.
3. **The payoff** (slide 13) — the same SSO question, asked again in the same Claude window
   as slide 10, now returns a complete answer cited to the newly-merged page. Typeset in the
   deck too, so the demo opens and closes on the same surface. (`demo-payoff` in
   `assets/opt/` is the screenshot this replaced — still rendered by
   `render-static-ui-shots.mjs`, no longer used by the deck.)

Questionnaires are deliberately **not** part of that spine: the core pitch is the knowledge
base and the loop that keeps it healthy. The deck closes on the applications
matrix (17) and then the questionnaire slide (18) — one row of that table worked through in
depth: upload the vendor's file, reuse and re-check, audit what was sent last time, approve
and export.

The demo frames (slides 11–13), like the product shots, are content-focused mock-ups rendered
by `scripts/render-static-ui-shots.mjs` — one coherent thread, styled from the theme tokens.

## Rebuilding

Content and styles live in `scripts/build-deck.mjs`. Every image is inlined as base64 so
the deck stays a single self-contained file. Images come from two places:

- `assets/opt/` — every deck image, all rendered by `scripts/render-static-ui-shots.mjs`:
  the product shots (`ask`, `conflicts`, `proposals`, `gaps`, `changes`, `questionnaires`) on
  slides 5–9 & 18, the demo mock-ups (`demo-cluster`, `demo-draft`, `demo-pr`, `demo-merged`)
  on slides 11–12, the `insights` question-journey chart on slide 14, plus the `icon`.
  (`demo-payoff` and `seed-plan` are still rendered but no longer used by the deck — slides 13
  and 15 are typeset instead.) These are **content-focused mock-ups**: one console surface
  each — deliberately without the sidebar/topbar chrome so the content fills the deck's
  browser frame — styled from the theme tokens (`apps/web/src/theme/theme.ts`). Product-shot
  content is real (pulled from the live KB); the demo content is a scripted scenario. They
  render straight into `opt/` as 2× PNGs; there is no separate optimize step.

```bash
# 1. (re)render the console product shots into assets/opt/
#    — name shots to re-render only those (recommended; see the font note below)
node scripts/render-static-ui-shots.mjs insights
# 2. assemble the single-file deck (writes both committed copies)
node scripts/build-deck.mjs
# 3. (optional) render specific slides to PNG to eyeball them (needs playwright)
node scripts/verify-deck.mjs 5 6 9 10 18
```

`CHROME_PATH` points the shot renderer at a Chrome/Chromium binary (it defaults to the
usual Windows install path); `CHROME_FLAGS` passes extra flags — `--no-sandbox` when
rendering as root inside a container. Fonts matter: the shots pick up whatever the
rendering machine has for `Inter`, so re-rendering everything on a different machine will
subtly restyle the committed shots. Re-render only the ones you changed — pass their names
as arguments (bare `node scripts/render-static-ui-shots.mjs` still rebuilds all of them).

The app no longer ships a single stylesheet (it moved to Emotion in #147), so these shots
are self-contained mock-ups rather than captures of the running console. To refresh their
content, edit the fixtures in `scripts/render-static-ui-shots.mjs`.
