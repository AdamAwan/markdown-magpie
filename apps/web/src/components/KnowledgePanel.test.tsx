import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { act, type ComponentProps } from "react";
import type { KnowledgeDocument, RepositoryRef } from "../lib/types";
import { buttonByText, buttonsByText, click, closeDom, renderDom } from "../test/dom";
import { installFakeApi, type FakeApi } from "../test/fakeApi";
import { configFixture, documentFixture } from "../test/fixtures";
import { renderMarkup } from "../test/render";
import { FlowsPanel, OTHER_DOCUMENTS_ID, RepositoryContextPanel } from "./KnowledgePanel";

type Props = ComponentProps<typeof FlowsPanel>;

// The document reader mounts DocumentChangeTimeline, which fetches the selected
// document's change log on its own; give it an empty log to read.
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({
    "GET /knowledge/changes": () => ({
      changes: [],
      summary: { total: 0, byKind: {}, byCause: {}, documentsTouched: 0 },
      limit: 10,
      offset: 0
    })
  });
});
afterEach(() => api.restore());
after(closeDom);

const config = configFixture();

function setup(overrides: Partial<Props> = {}) {
  const calls = { flows: [] as string[], documents: [] as string[], indexed: [] as string[] };
  const props: Props = {
    destinations: config.knowledge.destinations ?? [],
    sources: config.knowledge.sources ?? [],
    flows: config.knowledge.flows ?? [],
    documents: [],
    indexing: false,
    onIndex: async (flowId) => {
      calls.indexed.push(flowId);
    },
    selectedDocumentId: undefined,
    selectedFlowId: "billing",
    setSelectedDocumentId: (id) => {
      calls.documents.push(id);
    },
    setSelectedFlowId: (id) => {
      calls.flows.push(id);
    },
    ...overrides
  };
  return { calls, props };
}

async function mount(t: { after: (fn: () => void) => void }, overrides: Partial<Props> = {}) {
  const { calls, props } = setup(overrides);
  const mounted = await renderDom(<FlowsPanel {...props} />);
  // Let the change-timeline fetch for the selected document land.
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  t.after(() => mounted.unmount());
  return { ...mounted, calls, props };
}

function sidebar(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Knowledge flows"] > button')];
}

function billingDoc(path: string, overrides: Parameters<typeof documentFixture>[0] = {}): KnowledgeDocument {
  return documentFixture({ id: `billing-kb:${path}`, path, metadata: { title: path }, ...overrides });
}

test("with nothing configured the panel says which environment variables to set", () => {
  const { props } = setup({ flows: [], destinations: [], sources: [] });

  const html = renderMarkup(<FlowsPanel {...props} />);

  assert.match(html, /No knowledge flows are configured\. Add KNOWLEDGE_FLOWS or KNOWLEDGE_DESTINATIONS/);
});

test("the sidebar summarises each flow's sources, destination and its own documents", async (t) => {
  const documents = [
    billingDoc("rates.md"),
    billingDoc("refunds.md"),
    documentFixture({ id: "support-kb:faq.md", repositoryId: "support-kb", path: "faq.md" })
  ];
  const { container } = await mount(t, { documents });

  assert.deepEqual(
    sidebar(container).map((item) => [...item.children].map((child) => child.textContent)),
    [
      ["Billing", "2 sources → Billing KB · 2 docs"],
      ["Support", "0 sources → Support KB · 1 docs"]
    ]
  );
});

test("documents no flow produced are gathered into an Other documents bucket", async (t) => {
  const documents = [billingDoc("rates.md"), documentFixture({ id: "upload:notes.md", repositoryId: "uploads" })];
  const { container } = await mount(t, { documents, selectedFlowId: OTHER_DOCUMENTS_ID });

  assert.deepEqual(
    [...(sidebar(container).at(-1)?.children ?? [])].map((child) => child.textContent),
    ["Other documents", "1 unassigned doc"]
  );
  const text = container.textContent ?? "";
  assert.match(text, /Indexed documents not produced by a configured flow/);
  // The bucket has no destination to index and no pipeline to draw.
  assert.equal(buttonsByText(container, "Index KB").length, 0);
  assert.equal(container.querySelector('[aria-label="Knowledge flow pipeline"]'), null);
});

test("a flow whose source or destination id is not configured degrades to placeholders", async (t) => {
  const flows = [{ id: "orphan", name: "Orphan", sourceIds: ["gone"], destinationId: "missing-kb" }];
  const { container } = await mount(t, { flows, selectedFlowId: "orphan" });

  assert.equal(sidebar(container)[0].children[1].textContent, "0 sources → missing-kb · 0 docs");
  const pipeline = container.querySelector('[aria-label="Knowledge flow pipeline"]')?.textContent ?? "";
  assert.match(pipeline, /No sources/);
  assert.match(pipeline, /missing-kb/);
  // Nothing to index into, so the action is disabled rather than firing a doomed request.
  assert.equal(buttonByText(container, "Index KB").disabled, true);
});

test("an unknown selected flow falls back to the first flow", async (t) => {
  const { container } = await mount(t, { selectedFlowId: "retired" });

  assert.equal(container.querySelector("h3")?.textContent, "Billing");
});

test("picking a flow, a document or Index KB reports the choice to the provider", async (t) => {
  const documents = [billingDoc("rates.md"), billingDoc("refunds.md")];
  const { container, calls } = await mount(t, { documents });

  await click(sidebar(container)[1]);
  await click(buttonByText(container, "refunds.mdrefunds.md"));
  await click(buttonByText(container, "Index KB"));

  assert.deepEqual(calls.flows, ["support", "billing"]);
  assert.deepEqual(calls.documents, ["billing-kb:refunds.md"]);
  assert.deepEqual(calls.indexed, ["billing"]);
});

test("while indexing the button is disabled and says so", async (t) => {
  const { container } = await mount(t, { indexing: true });

  assert.equal(buttonByText(container, "Indexing").disabled, true);
});

test("documents are grouped by folder, folders and files sorted, root files under /", async (t) => {
  const documents = [
    billingDoc("guides/setup/install.md"),
    billingDoc("zebra.md"),
    billingDoc("guides/b.md"),
    billingDoc("guides/a.md"),
    billingDoc("alpha.md")
  ];
  const { container } = await mount(t, { documents });
  const groups = [...container.querySelectorAll("button")]
    .filter((button) => button.querySelector("small"))
    .filter((button) => !sidebar(container).includes(button))
    .map((button) => button.querySelector("span")?.textContent);

  assert.deepEqual(groups, ["alpha.md", "zebra.md", "guides/a.md", "guides/b.md", "guides/setup/install.md"]);
  const text = container.textContent ?? "";
  assert.ok(text.indexOf("/2") < text.indexOf("guides2"), "root folder is listed before guides");
  assert.match(text, /guides\/setup1/);
});

test("the reader shows the selected document, defaulting to the flow's first", async (t) => {
  const documents = [
    billingDoc("rates.md", {
      content: "RATES BODY",
      metadata: { title: "Rates", status: "active", tags: [], relatedDocs: [] }
    }),
    billingDoc("refunds.md", {
      content: "REFUNDS BODY",
      metadata: { title: "Refunds", owner: "finance", status: "draft", tags: ["policy"], relatedDocs: [] }
    })
  ];
  const { container, props, rerender } = await mount(t, { documents });
  const reader = () => container.querySelector("article")?.textContent ?? "";

  assert.match(reader(), /RATES BODY/);
  // Each selection fetches that document's own change timeline.
  assert.match(api.calls("GET", "/knowledge/changes").at(-1)?.search ?? "", /documentId=billing-kb%3Arates\.md$/);

  await rerender(<FlowsPanel {...props} selectedDocumentId="billing-kb:refunds.md" />);
  assert.match(reader(), /REFUNDS BODY/);
  assert.match(reader(), /finance/);
  assert.match(reader(), /policy/);

  // A selection that belongs to another flow is ignored rather than shown out of context.
  await rerender(<FlowsPanel {...props} selectedDocumentId="support-kb:faq.md" />);
  assert.match(reader(), /RATES BODY/);
});

test("a flow with no indexed documents says so", async (t) => {
  const { container } = await mount(t);

  assert.match(container.textContent ?? "", /No Markdown documents indexed yet\./);
});

test("Open shows the full document in a dialog that closes on Escape", async (t) => {
  const documents = [billingDoc("rates.md", { content: "FULL MARKDOWN" })];
  const { container } = await mount(t, { documents });

  await click(buttonByText(container, "Open"));
  const dialog = container.querySelector('[role="dialog"]');
  assert.equal(dialog?.getAttribute("aria-label"), "rates.md");
  assert.match(dialog?.textContent ?? "", /FULL MARKDOWN/);

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  assert.equal(container.querySelector('[role="dialog"]'), null);
});

test("the persona button appears only for flows with a persona and opens it", async (t) => {
  const { container, props, rerender } = await mount(t);

  const personaButton = container.querySelector<HTMLButtonElement>('button[aria-label="View persona for Billing"]');
  assert.ok(personaButton);
  await click(personaButton);
  const dialog = container.querySelector('[role="dialog"]');
  assert.equal(dialog?.getAttribute("aria-label"), "Billing persona");
  assert.match(dialog?.textContent ?? "", /Answer as a billing specialist\./);

  // Clicking the backdrop dismisses; clicking inside the dialog does not.
  assert.ok(dialog instanceof HTMLElement && dialog.parentElement);
  await click(dialog);
  assert.ok(container.querySelector('[role="dialog"]'));
  await click(dialog.parentElement);
  assert.equal(container.querySelector('[role="dialog"]'), null);

  await rerender(<FlowsPanel {...props} selectedFlowId="support" />);
  assert.equal(container.querySelector('button[aria-label^="View persona"]'), null);
});

// --- RepositoryContextPanel -------------------------------------------------

function repository(overrides: Partial<RepositoryRef> = {}): RepositoryRef {
  return {
    id: "billing-kb",
    name: "Billing KB",
    defaultBranch: "main",
    localPath: "/kb/billing",
    provider: "local",
    ...overrides
  };
}

test("repository context falls back sensibly when Git scope was never detected", () => {
  const html = renderMarkup(<RepositoryContextPanel repositories={[repository()]} />);

  assert.match(html, /1 repos/);
  assert.match(html, /title="Unknown"/);
  // Branch falls back to the configured default; HEAD and root are honest unknowns.
  assert.match(html, /<span>Branch<\/span><strong>main<\/strong>/);
  assert.match(html, /<span>HEAD<\/span><strong>Unknown<\/strong>/);
  assert.match(html, /<span>Git Root<\/span><strong>Not detected<\/strong>/);
  assert.match(html, /<span>Indexed Folder<\/span><strong>\/kb\/billing<\/strong>/);
  assert.match(html, /<span>Remote<\/span><strong>Not configured<\/strong>/);
  assert.match(html, /<span>Working Tree<\/span><strong>Clean<\/strong>/);
});

test("repository context prefers the detected Git state and labels each scope", () => {
  const html = renderMarkup(
    <RepositoryContextPanel
      repositories={[
        repository({
          id: "a",
          remoteUrl: "https://configured.test/repo.git",
          git: {
            scope: "subdirectory",
            indexedPath: "/work/repo/docs",
            workTreeRoot: "/work/repo",
            relativePathFromRoot: "docs",
            currentBranch: "feature/x",
            headSha: "0123456789abcdef0123",
            remoteUrl: "https://detected.test/repo.git",
            hasUncommittedChanges: true
          }
        }),
        repository({ id: "b", git: { scope: "repository-root", indexedPath: "/work/root" } }),
        repository({ id: "c", git: { scope: "not-git", indexedPath: "/plain" } })
      ]}
    />
  );

  for (const label of ["Git subfolder", "Git repo", "Not Git"]) {
    assert.match(html, new RegExp(`title="${label}"`));
  }
  assert.match(html, /<strong>feature\/x<\/strong>/);
  // HEAD is shortened to 12 characters.
  assert.match(html, /<strong>0123456789ab<\/strong>/);
  assert.match(html, /<span>Indexed Folder<\/span><strong>docs<\/strong>/);
  assert.match(html, /<strong>https:\/\/detected\.test\/repo\.git<\/strong>/);
  assert.match(html, /<strong>Uncommitted changes<\/strong>/);
  assert.match(html, /<strong>Not a git work tree<\/strong>/);
});

test("with no repositories indexed the context panel prompts to index one", () => {
  const html = renderMarkup(<RepositoryContextPanel repositories={[]} />);

  assert.match(html, /No repository context available yet\. Index a repository to detect its Git scope\./);
});
