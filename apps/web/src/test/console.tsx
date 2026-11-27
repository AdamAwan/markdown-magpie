import { renderDom } from "./dom";
import type { ReactElement } from "react";
import { act } from "react";
import { mock } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ConsoleProvider, useConsole } from "../components/ConsoleProvider";
import { installFakeApi, type FakeApi, type RouteHandler } from "./fakeApi";

type ConsoleValue = ReturnType<typeof useConsole>;

// Every endpoint the provider hits on mount (fast tier + slow tier), answering
// with an empty-but-valid console. Tests override the routes they care about.
function emptyConsoleRoutes(): Record<string, RouteHandler> {
  return {
    "GET /health": () => ({ ok: true, service: "magpie-api" }),
    "GET /knowledge/stats": () => ({ repositoryCount: 0, documentCount: 0, sectionCount: 0 }),
    "GET /questions": () => ({ questions: [], total: 0, matching: 0 }),
    "GET /gaps/candidates": () => ({ gaps: [] }),
    "GET /gaps/clusters": () => ({ clusters: [] }),
    "GET /jobs": () => ({ jobs: [], total: 0 }),
    "GET /jobs/schedules": () => ({ schedules: [] }),
    "GET /workers": () => ({ workers: [], uncoveredJobTypes: [] }),
    "GET /proposals": () => ({ proposals: [] }),
    "GET /scheduled-tasks": () => ({ tasks: [] }),
    "GET /maintenance-runs": () => ({ runs: [] }),
    "GET /reconciliations": () => ({ decisions: [] }),
    "GET /knowledge/repositories": () => ({ repositories: [], total: 0 }),
    "GET /knowledge/documents": () => ({ documents: [], total: 0 }),
    "GET /config": () => ({
      api: {},
      stores: {},
      knowledge: { repositoryPath: null },
      providers: {},
      aiRuntime: { provider: "codex" },
      retrieval: { mode: "keyword", reason: "No embedding provider configured.", embeddingProvider: null },
      watcher: {}
    }),
    "GET /prompts": () => ({ prompts: [] }),
    "GET /snapshots": () => ({ snapshots: [] }),
    "GET /source-map": () => ({ entries: [] })
  };
}

export interface MountedConsole {
  api: FakeApi;
  container: HTMLElement;
  /** The provider's current context value (state + actions), as a consumer sees it this render. */
  console: () => ConsoleValue;
  /** Every href the provider pushed onto the (fake) Next router. */
  pushes: string[];
  /** Run an action inside `act`, then wait for the requests it started to settle. */
  run: (action: () => unknown) => Promise<void>;
  /** Wait until the fake API has no request in flight and React has flushed. */
  settle: () => Promise<void>;
  /** Advance the mocked clock (toast expiry, search debounce, poll intervals), then settle. */
  tick: (ms: number) => Promise<void>;
  unmount: () => void;
}

/**
 * Mount the real ConsoleProvider over a fake API and a fake Next router, with
 * `setTimeout`/`setInterval` mocked so the provider's poll timers, toast expiry
 * and search debounce are driven by `tick` instead of the wall clock. Resolves
 * once the mount refresh has landed. `ui` is rendered inside the provider —
 * pass a page component to exercise provider + page + panel together.
 */
export async function mountConsole(
  options: { routes?: Record<string, RouteHandler>; ui?: ReactElement; pathname?: string } = {}
): Promise<MountedConsole> {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const api = installFakeApi({ ...emptyConsoleRoutes(), ...options.routes });
  const pushes: string[] = [];
  const router = {
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
    push: (href: string) => {
      pushes.push(href);
    },
    replace: () => undefined,
    prefetch: () => undefined,
    bfcacheId: "test"
  };

  let current: ConsoleValue | undefined;
  function Probe() {
    current = useConsole();
    return null;
  }

  const mounted = await renderDom(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={options.pathname ?? "/ask"}>
        <ConsoleProvider>
          <Probe />
          {options.ui}
        </ConsoleProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

  // The provider's requests resolve over real I/O turns (Response body reads),
  // not just microtasks, so yield macrotasks until nothing is in flight for a
  // few consecutive turns.
  async function settle() {
    let quietTurns = 0;
    for (let turn = 0; turn < 200 && quietTurns < 3; turn++) {
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      quietTurns = api.pending() === 0 ? quietTurns + 1 : 0;
    }
    if (api.pending() > 0) {
      throw new Error("Fake API still has requests in flight; a route handler never resolved.");
    }
  }

  await settle();

  return {
    api,
    container: mounted.container,
    console: () => {
      if (!current) {
        throw new Error("ConsoleProvider has not rendered yet");
      }
      return current;
    },
    pushes,
    run: async (action) => {
      await act(async () => {
        await action();
      });
      await settle();
    },
    settle,
    tick: async (ms) => {
      await act(async () => {
        mock.timers.tick(ms);
      });
      await settle();
    },
    unmount: () => {
      mounted.unmount();
      api.restore();
      mock.timers.reset();
    }
  };
}
