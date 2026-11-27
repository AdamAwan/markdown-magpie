# Testing the web console

How `apps/web` (the Next.js console) is tested, and how to run each layer. Conventions
for writing the tests live in the **`writing-magpie-tests`** skill; this note is the map.

## Layers

| Layer | Runs in | Command | Needs |
| --- | --- | --- | --- |
| Component / unit tests (`src/**/*.test.tsx`) | `node:test` + happy-dom | `npm test -w @magpie/web` | nothing |
| Browser smoke suite (`e2e/*.spec.ts`) | Playwright + Chromium | `npm run test:e2e:web` | a Chromium build |

Neither layer needs Postgres, the API or a watcher: both replace the API at the network
boundary and run the console's real request, state and rendering code against it.

## Component tests

Part of `npm test`, so they run in CI. Three harnesses in `apps/web/src/test`:

- `render.tsx` — static markup, no effects.
- `dom.tsx` — a real mount on a happy-dom document (effects, clicks, typed input).
- `console.tsx` — mounts the real `ConsoleProvider` over `fakeApi.ts` (a route-table
  `fetch` stand-in) with a fake Next router and mocked timers, so polling, toast expiry
  and the search debounce are driven by `tick(ms)` instead of the wall clock.

`fixtures.ts` holds typed builders (`jobFixture`, `questionFixture`, `configFixture`, …).

## Browser smoke suite

```bash
npm run test:e2e:web      # from the repo root
```

That builds the libraries and the web app, starts `next start` on port 3210
(`E2E_WEB_PORT` overrides it), and runs the specs in headless Chromium with tracing off.
Every `/api/*` request is answered in the browser by `page.route`
(`apps/web/e2e/mockApi.ts`). To re-run against a build you already have:

```bash
npm run test:e2e -w @magpie/web
```

What it covers: the console loads and redirects `/` to Ask; every sidebar section opens
and renders with no console errors and no unmocked request; a deep link survives a
reload; the ask flow goes from submit to queued to answered; an API outage surfaces as a
toast rather than a blank page.

Notes:

- **Not in `npm test` and not in CI.** Run it by hand when you change routing, the app
  shell, the provider or the ask flow.
- **Browser.** `@playwright/test` is pinned to an exact version so it matches one
  Chromium build. Install that build once with `npx playwright install chromium`, or
  point the suite at a Chromium you already have with `E2E_CHROMIUM_PATH=/path/to/chromium`.
- **A new endpoint needs a mock.** A request with no route in `mockApi.ts` is answered
  404 and fails the spec that triggered it — add an (empty-state) response there.
- **Auth is off.** The suite blanks the `AUTH0_*` settings for the server it starts, so
  the console renders signed-out regardless of your shell.
