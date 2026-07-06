import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import { LocalGitProposalPublisher } from "./index.js";
import { initBareRemoteWithClone } from "./test-support.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

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

  it("fails clearly when the configured base branch does not exist", async () => {
    const { repository } = await initBareRemoteWithClone();
    // The remote only has `main`; a stale/misconfigured default of `master` must
    // surface a named error, not git's opaque "invalid reference: master".
    const publisher = new LocalGitProposalPublisher();

    await assert.rejects(
      () =>
        publisher.publish({
          repository: { ...repository, defaultBranch: "master" },
          branchName: "magpie/topic",
          title: "docs: topic",
          markdown: "# v1\n",
          targetPath: "docs/topic.md"
        }),
      /branch "master".*does not exist/
    );
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

  it("regenerate re-cuts the branch from the fresh base tip and force-pushes", async () => {
    const { repository, clonePath } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();

    // First publish: branch is cut from the seed tip of main.
    const first = await publisher.publish({
      repository,
      branchName: "magpie/stale",
      title: "docs: stale",
      markdown: "# v1\n",
      targetPath: "docs/stale.md"
    });

    // main advances and touches the same file — this is what makes the branch stale.
    await git(clonePath, ["checkout", "main"]);
    await git(clonePath, ["config", "user.name", "Mover"]);
    await git(clonePath, ["config", "user.email", "mover@example.com"]);
    await execFileAsync("git", ["-C", clonePath, "commit", "--allow-empty", "-m", "main moves on"]);
    await git(clonePath, ["push", "origin", "main"]);
    await git(clonePath, ["fetch", "origin"]);
    const newMainTip = await git(clonePath, ["rev-parse", "origin/main"]);

    // Regenerate: re-cut from the fresh base and force-push.
    const regenerated = await publisher.publish({
      repository,
      branchName: "magpie/stale",
      title: "docs: stale",
      markdown: "# v2\n",
      targetPath: "docs/stale.md",
      regenerate: true
    });

    // The regenerated commit sits directly on the NEW main tip, not the old branch tip.
    const parent = await git(clonePath, ["rev-parse", `${regenerated.commitSha}^`]);
    assert.equal(parent, newMainTip, "regenerated commit is parented on the fresh base");
    assert.notEqual(regenerated.commitSha, first.commitSha);
    // The old branch commit is no longer in the branch's history (history was rewritten).
    await assert.rejects(
      () => git(clonePath, ["merge-base", "--is-ancestor", first.commitSha, regenerated.commitSha]),
      "the stale commit is not an ancestor of the regenerated branch"
    );
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
