import assert from "node:assert/strict";
import test from "node:test";
import type { Proposal } from "../lib/types";
import type { BulkProposalAction } from "../lib/console";
import { click, renderDom } from "../test/dom";
import { renderMarkup } from "../test/render";
import { ProposalPanel } from "./ProposalsPanel";

const noop = async () => undefined;

function branchPushed(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    title: "Configure X",
    status: "branch-pushed",
    targetPath: "configure-x.md",
    markdown: "# Configure X\n",
    evidence: [],
    createdAt: new Date(0).toISOString(),
    publication: {
      provider: "local-git",
      branchName: "magpie/proposal-abc",
      commitSha: "deadbeef",
      publishedAt: new Date(0).toISOString()
    },
    ...overrides
  };
}

function render(proposal: Proposal, pendingPublishIds?: ReadonlySet<string>): string {
  return renderList([proposal], proposal, pendingPublishIds);
}

function renderList(
  proposals: Proposal[],
  selectedProposal?: Proposal,
  pendingPublishIds?: ReadonlySet<string>
): string {
  return renderMarkup(
    <ProposalPanel
      loading={false}
      pendingPublishIds={pendingPublishIds ?? new Set()}
      publishProposal={noop}
      proposals={proposals}
      selectedProposal={selectedProposal ?? proposals[0]}
      setSelectedProposalId={() => undefined}
      updateProposalStatus={noop}
      mergeProposal={noop}
      rejectProposal={noop}
      bulkProposalAction={noop}
    />
  );
}

test("a local-git proposal shows Accept/Bin and no GitHub ceremony", () => {
  const html = render(branchPushed({ localGitDestination: true }));
  assert.match(html, />Accept</);
  assert.match(html, />Bin</);
  assert.doesNotMatch(html, />Publish Branch</);
  assert.doesNotMatch(html, />Mark Merged</);
  // The Pull request field is hidden for a local destination.
  assert.doesNotMatch(html, /Pull request/);
});

test("a github proposal keeps Publish Branch / Mark Merged and the PR field", () => {
  const html = render(branchPushed({ localGitDestination: false }));
  assert.match(html, />Publish Branch</);
  assert.match(html, />Mark Merged</);
  assert.match(html, /Pull request/);
  assert.doesNotMatch(html, />Accept</);
  assert.doesNotMatch(html, />Bin</);
});

test("a proposal with provenance renders the claims and their sources", () => {
  const html = render(
    branchPushed({
      provenance: [
        {
          claim: "Logs are retained for 12 months",
          anchor: "log-retention",
          sources: [{ sourceId: "src-1", path: "docs/ops/logging.md", lines: "L10-L14" }]
        }
      ]
    })
  );
  assert.match(html, /Claim provenance \(1\)/);
  assert.match(html, /Logs are retained for 12 months/);
  assert.match(html, /docs\/ops\/logging\.md/);
  assert.match(html, /L10-L14/);
});

test("a proposal without provenance renders no provenance section", () => {
  const html = render(branchPushed());
  assert.doesNotMatch(html, /Claim provenance/);
});

// --- draft context: in-flight PR links (#294c) ---

function draftContextOverride(url: string | undefined) {
  return {
    draftContext: {
      gapSummaries: [],
      sourceFiles: [],
      evidenceCount: 0,
      openPullRequests: [{ title: "In-flight work", url, status: "pr-opened" as const }]
    }
  };
}

test("an in-flight PR with an http(s) url renders as a clickable anchor", () => {
  const html = render(branchPushed(draftContextOverride("https://github.com/o/r/pull/2")));
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/2"[^>]*>In-flight work<\/a>/);
});

test("an in-flight PR with a javascript: url renders as plain text, never an anchor", () => {
  const html = render(branchPushed(draftContextOverride("javascript:alert(1)")));
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /<a[^>]*>In-flight work<\/a>/);
  assert.match(html, />In-flight work</);
});

test("an in-flight PR with a data: url renders as plain text, never an anchor", () => {
  const html = render(branchPushed(draftContextOverride("data:text/html,<script>alert(1)</script>")));
  assert.doesNotMatch(html, /<a[^>]*>In-flight work<\/a>/);
  assert.match(html, />In-flight work</);
});

// --- bulk selection + action bar ---

function draft(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    title: `Draft ${id}`,
    status: "draft",
    targetPath: `${id}.md`,
    markdown: `# ${id}\n`,
    evidence: [],
    createdAt: new Date(0).toISOString(),
    ...overrides
  };
}

function panelWith(
  proposals: Proposal[],
  bulkProposalAction: (action: BulkProposalAction, ids: string[]) => Promise<void>,
  pendingPublishIds: ReadonlySet<string> = new Set()
) {
  return (
    <ProposalPanel
      loading={false}
      pendingPublishIds={pendingPublishIds}
      publishProposal={noop}
      proposals={proposals}
      selectedProposal={proposals[0]}
      setSelectedProposalId={() => undefined}
      updateProposalStatus={noop}
      mergeProposal={noop}
      rejectProposal={noop}
      bulkProposalAction={bulkProposalAction}
    />
  );
}

test("the bulk bar is absent when there are no proposals", () => {
  const html = renderList([]);
  assert.doesNotMatch(html, /Select all/);
  assert.doesNotMatch(html, /Mark Ready/);
});

test("select-all counts only the selected proposals eligible per action and dispatches those ids", async () => {
  const calls: Array<{ action: BulkProposalAction; ids: string[] }> = [];
  const proposals = [
    draft("d1"),
    draft("d2"),
    branchPushed({ id: "b1", title: "Pushed local", localGitDestination: true })
  ];
  const { container, unmount } = await renderDom(
    panelWith(proposals, async (action, ids) => {
      calls.push({ action, ids });
    })
  );

  await click(container.querySelector<HTMLInputElement>('input[aria-label="Select all proposals"]')!);
  const text = container.textContent ?? "";
  assert.match(text, /3 of 3 selected/);
  assert.match(text, /Mark Ready \(2\)/);
  assert.match(text, /Publish \(0\)/);
  assert.match(text, /Accept \/ Merge \(1\)/);

  const readyChip = [...container.querySelectorAll("button")].find((button) =>
    /Mark Ready \(2\)/.test(button.textContent ?? "")
  );
  assert.ok(readyChip);
  await click(readyChip);
  // Only the two eligible drafts are dispatched — the branch-pushed proposal is
  // selected but not draft-able, so it never reaches the API as noise.
  assert.deepEqual(calls, [{ action: "ready", ids: ["d1", "d2"] }]);
  unmount();
});

test("a zero-eligible bulk chip is disabled", async () => {
  const { container, unmount } = await renderDom(panelWith([draft("d1")], noop));
  await click(container.querySelector<HTMLInputElement>('input[aria-label="Select Draft d1"]')!);
  const publishChip = [...container.querySelectorAll("button")].find((button) =>
    /Publish \(0\)/.test(button.textContent ?? "")
  );
  assert.ok(publishChip);
  assert.equal((publishChip as HTMLButtonElement).disabled, true);
  unmount();
});

// --- queued-publish state ---

test("a ready proposal with a queued publish job disables Publish and says so", async () => {
  const ready = draft("p1", { status: "ready" });
  const { container, unmount } = await renderDom(panelWith([ready], noop, new Set(["p1"])));
  const publishChip = [...container.querySelectorAll("button")].find((button) =>
    /^Publish Branch$/.test(button.textContent ?? "")
  );
  assert.ok(publishChip);
  assert.equal((publishChip as HTMLButtonElement).disabled, true);
  assert.match(container.textContent ?? "", /Publish queued/);
  unmount();
});

test("a ready local-git proposal with a queued publish job disables Publish for review", async () => {
  const ready = draft("p1", { status: "ready", localGitDestination: true });
  const { container, unmount } = await renderDom(panelWith([ready], noop, new Set(["p1"])));
  const publishChip = [...container.querySelectorAll("button")].find((button) =>
    /^Publish for review$/.test(button.textContent ?? "")
  );
  assert.ok(publishChip);
  assert.equal((publishChip as HTMLButtonElement).disabled, true);
  unmount();
});

test("a queued publish drops the proposal from the bulk Publish count", async () => {
  const proposals = [draft("p1", { status: "ready" }), draft("p2", { status: "ready" })];
  const { container, unmount } = await renderDom(panelWith(proposals, noop, new Set(["p1"])));
  await click(container.querySelector<HTMLInputElement>('input[aria-label="Select all proposals"]')!);
  assert.match(container.textContent ?? "", /Publish \(1\)/);
  unmount();
});

test("a PR-tracked proposal is never counted toward Accept / Merge", async () => {
  const prTracked = branchPushed({
    id: "pr1",
    title: "PR tracked",
    status: "pr-opened",
    publication: {
      provider: "local-git",
      branchName: "magpie/proposal-pr",
      commitSha: "cafef00d",
      pullRequestUrl: "https://github.com/o/r/pull/1",
      publishedAt: new Date(0).toISOString()
    }
  });
  const { container, unmount } = await renderDom(panelWith([prTracked], noop));
  await click(container.querySelector<HTMLInputElement>('input[aria-label="Select all proposals"]')!);
  assert.match(container.textContent ?? "", /Accept \/ Merge \(0\)/);
  unmount();
});
