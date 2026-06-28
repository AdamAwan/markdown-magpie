import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { LocalGitProposalPublisher } from "./index.js";
import { initBareRemoteWithClone } from "./test-support.js";

describe("LocalGitProposalPublisher create-or-update", () => {
  before(() => {
    // The publisher requires an explicit committer identity for its commits.
    process.env.MAGPIE_GIT_AUTHOR_NAME = "Magpie Bot";
    process.env.MAGPIE_GIT_AUTHOR_EMAIL = "bot@example.com";
  });

  it("creates the branch on first publish and updates it on the second without force", async () => {
    const { repository } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();

    const first = await publisher.publish({
      repository,
      branchName: "magpie/topic",
      title: "docs: topic",
      markdown: "# v1\n",
      targetPath: "docs/topic.md"
    });
    assert.ok(first.commitSha);

    const second = await publisher.publish({
      repository,
      branchName: "magpie/topic",
      title: "docs: topic (updated)",
      markdown: "# v2\n",
      targetPath: "docs/topic.md"
    });
    assert.notEqual(second.commitSha, first.commitSha, "a new commit lands on the existing branch");
  });

  it("returns the existing tip when the regenerated document is unchanged", async () => {
    const { repository } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();

    const first = await publisher.publish({
      repository,
      branchName: "magpie/stable",
      title: "docs: stable",
      markdown: "# same\n",
      targetPath: "docs/stable.md"
    });

    const second = await publisher.publish({
      repository,
      branchName: "magpie/stable",
      title: "docs: stable (no change)",
      markdown: "# same\n",
      targetPath: "docs/stable.md"
    });
    assert.equal(second.commitSha, first.commitSha, "no new commit when content is identical");
  });

  it("updates an existing changeset branch without force", async () => {
    const { repository } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();

    const first = await publisher.publishChangeset({
      repository,
      branchName: "magpie/changeset",
      title: "docs: changeset",
      changes: [
        { path: "docs/a.md", content: "# A v1\n" },
        { path: "docs/b.md", content: "# B\n" }
      ]
    });

    const second = await publisher.publishChangeset({
      repository,
      branchName: "magpie/changeset",
      title: "docs: changeset (updated)",
      changes: [
        { path: "docs/a.md", content: "# A v2\n" },
        { path: "docs/b.md", delete: true }
      ]
    });

    assert.notEqual(second.commitSha, first.commitSha, "a new commit lands on the existing changeset branch");
  });
});
