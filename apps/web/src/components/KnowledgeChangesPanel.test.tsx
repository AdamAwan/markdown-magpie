import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeChange, KnowledgeChangesResponse } from "../lib/types";
import { renderMarkup } from "../test/render";
import { DocumentChangeTimelineView, KnowledgeChangesView } from "./KnowledgeChangesPanel";

const noop = () => {};

function change(overrides: Partial<KnowledgeChange> = {}): KnowledgeChange {
  return {
    id: "change-1",
    repositoryId: "billing-kb",
    documentId: "billing-kb:rates.md",
    path: "rates.md",
    anchor: "rate-tiers",
    heading: "Rate tiers",
    kind: "section_changed",
    changedAt: "2026-08-12T09:14:02.000Z",
    cause: "external",
    flowId: "billing",
    ...overrides
  };
}

function response(overrides: Partial<KnowledgeChangesResponse> = {}): KnowledgeChangesResponse {
  return {
    changes: [change()],
    summary: {
      total: 1,
      documentsTouched: 1,
      byKind: {
        document_added: 0,
        document_removed: 0,
        section_added: 0,
        section_removed: 0,
        section_changed: 1
      },
      byCause: { gap: 0, source_sync: 0, patrol: 0, seed: 0, external: 1 },
      logStartedAt: "2026-08-01T10:00:00.000Z"
    },
    limit: 25,
    offset: 0,
    ...overrides
  };
}

function panel(data: KnowledgeChangesResponse | undefined, loading = false) {
  return renderMarkup(
    <KnowledgeChangesView data={data} error={undefined} loading={loading} onWindowChange={noop} window="week" />
  );
}

test("the changes panel renders an entry as section, attribution and day", () => {
  const html = panel(
    response({
      changes: [
        change({
          cause: "source_sync",
          sourceId: "product-repo",
          sourceFromSha: "a1b2f3aa",
          sourceToSha: "c3d4e5bb",
          summary: "Sync docs to product-repo changes"
        })
      ]
    })
  );

  assert.match(html, /§ Rate tiers changed/);
  assert.match(html, /source product-repo a1b2f3aa…c3d4e5bb/);
  assert.match(html, /12 Aug/);
  assert.match(html, /Sync docs to product-repo changes/);
});

test("an attributed entry links to its proposal", () => {
  const html = panel(response({ changes: [change({ proposalId: "p-42" })] }));

  assert.match(html, /href="\/proposals#proposal-p-42"/);
});

test("an entry whose sync run was capped reports both file counts", () => {
  const html = panel(
    response({
      changes: [
        change({
          cause: "source_sync",
          sourceId: "product-repo",
          sourceToSha: "c3d4e5bb",
          upstream: { changedFileCount: 1412, examinedFileCount: 1000 }
        })
      ]
    })
  );

  // A change log that implies a completeness it does not have is the failure mode
  // this line exists to prevent.
  assert.match(html, /1,412 files changed upstream \(1,000 examined\)/);
});

test("an entry whose sync run examined everything carries no truncation line", () => {
  const html = panel(
    response({
      changes: [change({ cause: "source_sync", upstream: { changedFileCount: 12, examinedFileCount: 12 } })]
    })
  );

  assert.doesNotMatch(html, /examined/);
});

test("an empty window still reports when the log started", () => {
  const html = panel(response({ changes: [], summary: { ...response().summary, total: 0 } }));

  assert.match(html, /Nothing recorded in this window\. The change log starts 1 Aug\./);
});

test("an empty log says nothing has been recorded rather than nothing changed", () => {
  const empty = response({ changes: [], summary: { ...response().summary, total: 0 } });
  delete empty.summary.logStartedAt;

  const html = panel(empty);

  assert.match(html, /Nothing recorded yet/);
  assert.match(html, /never backfilled/);
});

test("the document timeline renders its entries and its own empty state", () => {
  const withEntries = renderMarkup(<DocumentChangeTimelineView data={response()} error={undefined} loading={false} />);
  assert.match(withEntries, /Change history/);
  assert.match(withEntries, /§ Rate tiers changed/);
  assert.match(withEntries, /1 recorded/);

  const emptyTimeline = renderMarkup(
    <DocumentChangeTimelineView
      data={response({ changes: [], summary: { ...response().summary, total: 0 } })}
      error={undefined}
      loading={false}
    />
  );
  assert.match(emptyTimeline, /The change log starts 1 Aug\./);
});

test("a document-level entry names the document rather than a section", () => {
  const html = panel(
    response({ changes: [change({ kind: "document_removed", anchor: undefined, heading: undefined })] })
  );

  assert.match(html, /rates\.md removed/);
  assert.doesNotMatch(html, /§/);
});
