import assert from "node:assert/strict";
import test from "node:test";
import type { Proposal } from "../lib/types";
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

function render(proposal: Proposal): string {
  return renderMarkup(
    <ProposalPanel
      loading={false}
      publishProposal={noop}
      proposals={[proposal]}
      selectedProposal={proposal}
      setSelectedProposalId={() => undefined}
      updateProposalStatus={noop}
      mergeProposal={noop}
      rejectProposal={noop}
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
