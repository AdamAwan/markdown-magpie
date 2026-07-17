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

## The demo (slides 8–11) + Questionnaires (slide 12)

A single scenario, followed end to end — no live stack required. A user asks Magpie's Sales
KB whether it supports **single sign-on**; the KB doesn't cover it yet, so the loop fills the
gap and the same question is answered on re-ask.

1. **In Claude** (slide 8) — a styled transcript of two `kb_ask` calls: a covered question
   answered with **HIGH** confidence and citations, and the SSO question the engine abstains
   on and flags as a gap (**LOW**). Typeset in the deck rather than screenshotted.
2. **Backstage** (slides 9–10) — the SSO gap is clustered and a page is drafted (slide 9),
   then raised as a PR, reviewed, merged & re-indexed (slide 10).
3. **The payoff** (slide 11) — the same SSO question now returns a complete, cited answer.

Slide 12 then shows **Questionnaires** — the same grounded engine answering a whole batch,
reusing prior answers and flagging what changed.

The demo frames (slides 9–11), like the product shots, are content-focused mock-ups rendered
by `scripts/render-static-ui-shots.mjs` — one coherent thread, styled from the theme tokens.

## Rebuilding

Content and styles live in `scripts/build-deck.mjs`. Every image is inlined as base64 so
the deck stays a single self-contained file. Images come from two places:

- `assets/opt/` — every deck image, all rendered by `scripts/render-static-ui-shots.mjs`:
  the product shots (`ask`, `gaps`, `proposals`, `questionnaires`) on slides 5–7 & 12, the
  demo mock-ups (`demo-cluster`, `demo-draft`, `demo-pr`, `demo-merged`, `demo-payoff`) on
  slides 9–11, the `seed-plan` shot on slide 16, plus the `icon`. These are **content-focused mock-ups**: one console surface
  each — deliberately without the sidebar/topbar chrome so the content fills the deck's
  browser frame — styled from the theme tokens (`apps/web/src/theme/theme.ts`). Product-shot
  content is real (pulled from the live KB); the demo content is a scripted scenario. They
  render straight into `opt/` as 2× PNGs; there is no separate optimize step.

```bash
# 1. (re)render the console product shots into assets/opt/
node scripts/render-static-ui-shots.mjs
# 2. assemble the single-file deck (writes both committed copies)
node scripts/build-deck.mjs
# 3. (optional) render specific slides to PNG to eyeball them (needs playwright)
node scripts/verify-deck.mjs 5 6 7 8 12
```

The app no longer ships a single stylesheet (it moved to Emotion in #147), so these shots
are self-contained mock-ups rather than captures of the running console. To refresh their
content, edit the fixtures in `scripts/render-static-ui-shots.mjs`.
