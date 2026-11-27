import { defineConfig, devices } from "@playwright/test";

// Browser smoke suite for the console (see e2e/). It runs the production build
// of the web app only — every /api/* request is answered in the browser by
// page.route (e2e/mockApi.ts), so no API, Postgres or watcher is needed.
//
// Run with `npm run test:e2e:web` from the repo root. Deliberately not part of
// `npm test` or CI.

const port = Number(process.env.E2E_WEB_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${port}`;

// Playwright normally launches the Chromium build matching its own version.
// Where only a different build is installed, point it at that binary instead.
const executablePath = process.env.E2E_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  // Failure artifacts go under node_modules so git, prettier and eslint all ignore them.
  outputDir: "./node_modules/.cache/playwright",
  fullyParallel: true,
  forbidOnly: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "off",
    launchOptions: executablePath ? { executablePath } : {}
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${port}`,
    url: `${baseURL}/ask`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // The suite drives the console signed-out. Blank the Auth0 settings the
      // layout reads per request so a developer's shell can't switch the app
      // into its login gate.
      AUTH0_DOMAIN: "",
      AUTH0_CLIENT_ID: "",
      AUTH0_AUDIENCE: "",
      NEXT_PUBLIC_AUTH0_DOMAIN: "",
      NEXT_PUBLIC_AUTH0_CLIENT_ID: "",
      NEXT_PUBLIC_AUTH0_AUDIENCE: ""
    }
  }
});
