import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { LocalGitProposalPublisher } from "./index.js";
import { initBareRemoteWithClone } from "./test-support.js";

describe("LocalGitProposalPublisher concurrency", () => {
  before(() => {
    process.env.MAGPIE_GIT_AUTHOR_NAME = "Magpie Bot";
    process.env.MAGPIE_GIT_AUTHOR_EMAIL = "bot@example.com";
  });

  it("publishes many branches concurrently against one checkout without racing", async () => {
    const { repository } = await initBareRemoteWithClone();
    const publisher = new LocalGitProposalPublisher();

    const results = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        publisher.publish({
          repository,
          branchName: `magpie/topic-${index}`,
          title: `docs: topic ${index}`,
          markdown: `# topic ${index}\n`,
          targetPath: `docs/topic-${index}.md`
        })
      )
    );

    assert.equal(results.length, 6);
    for (const result of results) {
      assert.ok(result.commitSha, "each concurrent publish produced a commit");
    }
  });
});
