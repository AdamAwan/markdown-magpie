import type { Page } from "@playwright/test";
import { configFixture } from "../src/test/fixtures";

// The Magpie API, mocked at the network layer. Every request whose path starts
// with /api/ is fulfilled here, in the browser context, so the suite needs no
// API, database or watcher. Routes are keyed "METHOD /path" (no /api prefix, no
// query string). A request with no route is answered 404 and recorded in
// `unmocked`, which the specs assert is empty — a new endpoint a page starts
// calling must be given a response here rather than silently failing.

interface MockRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

/** Returns the JSON body to answer with. Throw a MockApiError for a non-2xx answer. */
type MockHandler = (request: MockRequest) => unknown;

export class MockApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface MockApi {
  requests: MockRequest[];
  /** "METHOD /path" of every request that had no route. */
  unmocked: string[];
  calls(method: string, path: string): MockRequest[];
  on(route: string, handler: MockHandler): void;
}

const emptyPage = { limit: 25, offset: 0, total: 0 };

// A healthy, empty, two-flow console: enough for every section to render its
// real (empty-state) UI.
function defaultRoutes(): Record<string, MockHandler> {
  return {
    // --- ConsoleProvider fast tier
    "GET /health": () => ({ ok: true, service: "magpie-api" }),
    "GET /knowledge/stats": () => ({ repositoryCount: 2, documentCount: 0, sectionCount: 0 }),
    "GET /questions": () => ({ questions: [], total: 0, matching: 0 }),
    "GET /gaps/candidates": () => ({ gaps: [] }),
    "GET /gaps/clusters": () => ({ clusters: [] }),
    "GET /jobs": () => ({ jobs: [], total: 0 }),
    "GET /jobs/schedules": () => ({ schedules: [] }),
    "GET /workers": () => ({
      workers: [
        { name: "watcher-a", status: "idle", capabilities: ["codex", "github"], lastSeenAt: new Date().toISOString() },
        { name: "watcher-b", status: "idle", capabilities: ["maintenance"], lastSeenAt: new Date().toISOString() }
      ],
      uncoveredJobTypes: []
    }),
    "GET /proposals": () => ({ proposals: [] }),
    "GET /scheduled-tasks": () => ({ tasks: [] }),
    "GET /maintenance-runs": () => ({ runs: [] }),
    "GET /reconciliations": () => ({ decisions: [] }),
    // --- ConsoleProvider slow tier
    "GET /knowledge/repositories": () => ({ repositories: [], total: 0 }),
    "GET /knowledge/documents": () => ({ documents: [], total: 0 }),
    "GET /config": () => configFixture(),
    "GET /prompts": () => ({
      prompts: [
        {
          id: "answer_question",
          title: "Answer a question",
          description: "Drafts a cited answer from retrieved sections.",
          usedBy: ["answer_question"],
          outputShape: "{ answer, confidence, citations }",
          instructions: "Answer only from the provided context."
        }
      ]
    }),
    "GET /snapshots": () => ({ snapshots: [] }),
    "GET /source-map": () => ({ entries: [] }),
    // --- per-section reads
    "GET /version": () => ({ sha: null, commitMessage: null, committedAt: null }),
    "GET /questions/parked": () => ({ questions: [], proposals: [] }),
    "GET /knowledge/changes": () => ({
      changes: [],
      summary: {
        total: 0,
        documentsTouched: 0,
        byKind: { document_added: 0, document_removed: 0, section_added: 0, section_removed: 0, section_changed: 0 },
        byCause: { gap: 0, source_sync: 0, patrol: 0, seed: 0, external: 0 }
      },
      limit: 25,
      offset: 0
    }),
    "GET /knowledge/citation-usage": () => ({
      summary: {
        indexedSections: 0,
        citedSections: 0,
        uncitedSections: 0,
        indexedDocuments: 0,
        citedDocuments: 0,
        uncitedDocuments: 0,
        totalCitations: 0,
        unindexedUsageRows: 0
      },
      rows: [],
      total: 0
    }),
    "GET /source-conflicts": () => ({ conflicts: [], ...emptyPage }),
    "GET /asserted-claims": () => ({ claims: [], ...emptyPage }),
    "GET /questionnaires": () => ({ questionnaires: [] }),
    "GET /flows/billing/seed-plans": () => ({ plans: [] }),
    "GET /flows/support/seed-plans": () => ({ plans: [] }),
    // --- insights charts (empty windows)
    "GET /insights/gaps/backlog": () => ({ series: [] }),
    "GET /insights/journey": () => ({ nodes: [], links: [] }),
    "GET /insights/jobs/throughput": () => ({ series: [] }),
    "GET /insights/answers/latency": () => ({ bins: [] }),
    "GET /insights/verification/success": () => ({ totals: { closed: 0, stillOpen: 0 }, series: [] }),
    "GET /insights/feedback": () => ({ totals: { helpful: 0, unhelpful: 0, unhelpfulConfident: 0 }, series: [] }),
    "GET /insights/jobs/errors": () => ({ byCategory: [], byType: [] }),
    "GET /insights/freshness": () => ({
      documents: { fresh: 0, due: 0, overdue: 0 },
      sources: { fresh: 0, stale: 0 }
    }),
    "GET /insights/patrols": () => ({ runs: [] }),
    "GET /insights/ai-usage": () => ({ usage: [] }),
    "GET /insights/ai-cost/by-flow": () => ({ flows: [] }),
    "GET /insights/ai-cost/by-schedule": () => ({ schedules: [] })
  };
}

export async function mockApi(page: Page, routes: Record<string, MockHandler> = {}): Promise<MockApi> {
  const table = new Map<string, MockHandler>(Object.entries({ ...defaultRoutes(), ...routes }));
  const requests: MockRequest[] = [];
  const unmocked: string[] = [];

  await page.route(
    (url) => url.pathname === "/api" || url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url());
      const request: MockRequest = {
        method: route.request().method(),
        path: url.pathname.replace(/^\/api/, ""),
        search: url.searchParams,
        body: route.request().postDataJSON()
      };
      requests.push(request);
      const key = `${request.method} ${request.path}`;
      const handler = table.get(key);
      if (!handler) {
        unmocked.push(key);
        await route.fulfill({ status: 404, json: { message: `No mock route for ${key}` } });
        return;
      }
      try {
        await route.fulfill({ status: 200, json: handler(request) ?? {} });
      } catch (error) {
        if (!(error instanceof MockApiError)) {
          throw error;
        }
        await route.fulfill({ status: error.status, json: { message: error.message } });
      }
    }
  );

  return {
    requests,
    unmocked,
    calls: (method, path) => requests.filter((request) => request.method === method && request.path === path),
    on: (route, handler) => {
      table.set(route, handler);
    }
  };
}

/**
 * Collects everything the page logs as an error, plus uncaught exceptions.
 * Specs assert the list is empty: a hydration mismatch, a render throw caught by
 * the error boundary or a failed request all land here.
 */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`Uncaught: ${error.message}`);
  });
  return errors;
}
