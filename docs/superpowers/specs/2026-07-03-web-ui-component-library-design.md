# Web UI component library + visual refresh — design

Date: 2026-07-03
Status: approved, in implementation
Area: `apps/web`

## Problem

`apps/web` has no component library. All styling lives in one 2,765-line global
stylesheet (`src/app/styles.css`, ~243 classes) with hardcoded hex colours and pixel
spacing. Buttons are bare `<button className="button …">` repeated across ~40 sites; the
badge story is three overlapping, near-identical classes (`.pill`, `.chip`, `.status`)
plus one-off variants (`.flowPill`, `.capabilityPill`, `.jobTypePill`). Styling is
*centralised* (one file, reused class names) but *un-abstracted* (no components, no
tokens), so panels hand-assemble class strings and the badge families quietly drift.

Goal: introduce a real component library and design tokens, and apply a light visual
refresh — evenly across the whole app.

## Decisions

- **Engine: Emotion** (`@emotion/react` + `@emotion/styled`). The app is fresh Next 16 /
  React 19; styled-components is in maintenance mode with React 19 friction, so Emotion is
  the healthiest way to get the requested colocated CSS-in-JS DX (`styled.button` tagged
  templates, no hand-written `.css` files). We enable Next's SWC Emotion transform
  (`compiler.emotion`) for readable class labels and `css`-prop support — no Babel.
- **Strategy: foundation-first, migrate screen-by-screen.** Tokens + primitives land
  first; panels move off `styles.css` one at a time, deleting the matching CSS as each
  lands, until `styles.css` is gone (bar a tiny reset moved into an Emotion `Global`).
- **Visual direction: "Refined sage".** Keep the existing identity; add a 6px control /
  12px card radius, softer warmer borders, a whisper of card shadow, sentence-case badges
  with a status dot, and drop the shouty 850-weight uppercase to a calmer 600.
- **Scope guards (YAGNI):** no dark mode (app is `color-scheme: light`); no reworking of
  panel *logic* — styling extraction + the visual pass only. A panel's internals are split
  into sub-components only where the file is already unwieldy (e.g. `JobsPanel`).

## Architecture

### App Router + SSR wiring

- `src/app/EmotionRegistry.tsx` — a `"use client"` component that creates an Emotion cache
  and flushes inserted styles during SSR via `useServerInsertedHTML` (the documented App
  Router pattern; prevents FOUC and hydration mismatch). It also mounts the `ThemeProvider`
  and an Emotion `<Global>` carrying the reset + `@font-face`/base typography that used to
  sit at the top of `styles.css`.
- `layout.tsx` wraps `{children}` (inside the existing providers) with `EmotionRegistry`.
- `next.config.mjs` gains `compiler: { emotion: true }`.

### Design tokens — `src/theme/theme.ts`

A single typed `theme` object, values taken from today's palette promoted to semantic
names (Refined-sage values):

- `color`: `text`, `textMuted`, `textSubtle`, `page`, `surface`, `surfaceMuted`, `border`,
  `borderStrong`, `accent`, `accentBg`, `primary`, `primaryText`, and a `status` map
  (`completed` | `failed` | `running` | `pending` | `neutral`, each `{ fg, bg, border,
  dot }`).
- `space`: `{ xs:4, sm:6, md:8, lg:12, xl:16, xxl:24 }`.
- `radius`: `{ sm:6, md:8, card:12 }`.
- `font`: families (`sans`, `mono`), size scale, weight scale.
- `shadow`: `{ card }`. `border`: hairline helper string.

Emotion's `Theme` interface is augmented (`src/theme/emotion.d.ts`) to equal `AppTheme`,
so `styled.button(p => p.theme.color.accent)` is fully typed. No `any`, no casts through
`unknown`.

### Primitive library — `src/components/ui/`

Each primitive is a small single-purpose `.tsx` with colocated Emotion styles and a
focused `.test.tsx`. Primitives expose stable `data-*` / `role` hooks so SSR tests assert
on semantics, not Emotion's hashed class names.

| Component            | Key props                                                       | Replaces |
|----------------------|----------------------------------------------------------------|----------|
| `Button`             | `variant: primary\|secondary\|danger\|ghost`, `size: sm\|md`   | `.button(.secondary/.danger)`, `.flowDocOpen` |
| `IconButton`         | `label` (required, a11y), `size`                               | `.iconButton`, `.jobDetailClose` |
| `Badge`              | `tone: neutral\|accent\|<status>`, `dot?`, `mono?` (static)    | `.pill`, `.status*`, `.flowPill`, `.capabilityPill`, `.jobTypePill` |
| `Chip`               | `selected?` (interactive button)                               | `.chip`, `.chip.selected` |
| `Surface` (+ `.Header`, `.Body`) | compound card                                      | `.surface`, `.surfaceHeader`, `.surfaceBody` |
| `Field` (+ `Input`, `Textarea`, `Select`) | `label`                                   | `.field`, form inputs |
| `Tabs`               | `items`, `value`, `onChange`                                   | `.tabs`, `.tab` |
| `Stack` / `Row`      | `gap`, `align`                                                 | ad-hoc flex/grid |

`Badge` (static label) and `Chip` (interactive toggle) stay separate — that split is the
real fix for today's `.pill`/`.chip` confusion.

## Testing

Existing tests render with `renderToStaticMarkup` (no DOM / RTL) and a few assert on exact
class names that Emotion will replace with hashed labels. Approach:

- Add `src/test/render.tsx` exporting `renderMarkup(ui)` =
  `renderToStaticMarkup(<ThemeProvider theme={theme}>{ui}</ThemeProvider>)`, since themed
  styled components read the theme from context (without a provider `theme` is `{}` and
  access throws).
- Migrate each panel's test alongside the panel: switch to `renderMarkup`, and replace
  class-name assertions with text / `role` / `data-*` assertions.
- Each primitive gets its own test (variant → hook, `Badge` tone, disabled state, etc.).
- Gate every step on `npm run build && npm test && npm run typecheck && npm run lint`.

## Migration order (each step: its own commit + push, verified in the running app)

1. Emotion + registry + theme + Emotion typing + `compiler.emotion`. App looks identical.
2. Build `ui/` primitives with tests, in isolation.
3. Migrate panels smallest → largest, deleting matching `styles.css` rules per panel:
   `common.tsx` → `AskPanel` → `Proposals`/`Config`/`Schedules`/`Seed`/`Prompts`/`Gaps`/
   `Reconciliations`/`Snapshots`/`Activity`/`Knowledge`/`McpPanel` → `JobsPanel` →
   `AppShell` + `dataflow/`.
4. When the last panel is off it, delete `styles.css`; keep only the reset/base in the
   Emotion `Global`.

## Non-goals

- Dark mode. Panel logic refactors beyond styling. New features. Changing API shapes.
