import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDocumentPath, findUnsafeChangesetPath } from "./document-path.js";

function rejected(rawPath: string, subtree?: string): string {
  const check = checkDocumentPath(rawPath, subtree);
  assert.equal(check.ok, false, `expected ${JSON.stringify(rawPath)} to be rejected`);
  return check.ok ? "" : check.reason;
}

function accepted(rawPath: string, subtree?: string): string {
  const check = checkDocumentPath(rawPath, subtree);
  assert.equal(check.ok, true, `expected ${JSON.stringify(rawPath)} to be accepted: ${check.ok ? "" : check.reason}`);
  return check.ok ? check.path : "";
}

describe("checkDocumentPath", () => {
  it("accepts a plain and a nested Markdown document", () => {
    assert.equal(accepted("overview.md"), "overview.md");
    assert.equal(accepted("ops/runbooks/deploy-v2.md"), "ops/runbooks/deploy-v2.md");
  });

  it("accepts an uppercase extension, matching the indexer's case-insensitive .md", () => {
    assert.equal(accepted("README.MD"), "README.MD");
  });

  it("accepts non-ASCII document names verbatim (no normalisation)", () => {
    assert.equal(accepted("guides/café.md"), "guides/café.md");
    assert.equal(accepted("文档/概述.md"), "文档/概述.md");
  });

  it("rejects traversal", () => {
    assert.match(rejected("../x.md"), /\.\./);
    assert.match(rejected("docs/../../.github/workflows/x.md"), /\.\./);
    assert.match(rejected("docs/.."), /\.\./);
  });

  it("rejects absolute, drive-letter, UNC, backslash and home-relative paths", () => {
    assert.match(rejected("/etc/passwd.md"), /relative/);
    assert.match(rejected("C:/x.md"), /colon/);
    assert.match(rejected("c:x.md"), /colon/);
    assert.match(rejected("docs\\..\\x.md"), /backslash/);
    assert.match(rejected("\\\\server\\share\\x.md"), /backslash/);
    assert.match(rejected("~/x.md"), /home/);
    assert.match(rejected("x.md:stream"), /colon/);
  });

  it("rejects dot-directories and dot-files at any depth", () => {
    assert.match(rejected(".github/workflows/x.md"), /dot-segment/);
    assert.match(rejected("docs/.git/config.md"), /dot-segment/);
    assert.match(rejected(".GITHUB/x.md"), /dot-segment/);
    assert.match(rejected("./x.md"), /dot-segment/);
    assert.match(rejected("docs/.hidden.md"), /dot-segment/);
  });

  it("rejects node_modules, which the indexer never indexes", () => {
    assert.match(rejected("node_modules/pkg/readme.md"), /node_modules/);
    assert.match(rejected("docs/Node_Modules/x.md"), /node_modules/i);
  });

  it("rejects non-Markdown targets", () => {
    assert.match(rejected("package.json"), /\.md/);
    assert.match(rejected(".github/workflows/x.yml"), /dot-segment/);
    assert.match(rejected("docs/x.mdx"), /\.md/);
    assert.match(rejected("docs/x.md.sh"), /\.md/);
    assert.match(rejected("docs/x.markdown"), /\.md/);
    assert.match(rejected("docs/x"), /\.md/);
  });

  it("rejects empty segments, trailing slashes and trailing dots/spaces", () => {
    assert.match(rejected(""), /empty/);
    assert.match(rejected("docs//x.md"), /empty segment/);
    assert.match(rejected("docs/x.md/"), /empty segment/);
    assert.match(rejected("docs/x.md."), /trailing dot/);
    assert.match(rejected("docs /x.md"), /whitespace/);
    assert.match(rejected(".. /x.md"), /dot-segment/);
  });

  it("rejects control characters and invisible Unicode format characters", () => {
    assert.match(rejected("docs/x\u0000.md"), /control/);
    assert.match(rejected("docs/x\n.md"), /control/);
    assert.match(rejected("\u200c.git/x.md"), /format/);
    assert.match(rejected("docs/\u202Edm.x"), /format/);
  });

  describe("with a destination subtree", () => {
    it("prefixes a subtree-relative path", () => {
      assert.equal(accepted("ops/deploy.md", "kb"), "kb/ops/deploy.md");
    });

    it("keeps a path that already carries the subtree prefix", () => {
      assert.equal(accepted("kb/deploy.md", "kb"), "kb/deploy.md");
      assert.equal(accepted("kb/deploy.md", "/kb/"), "kb/deploy.md");
    });

    it("treats '.', empty and undefined as a repository-root index", () => {
      assert.equal(accepted("deploy.md", "."), "deploy.md");
      assert.equal(accepted("deploy.md", ""), "deploy.md");
      assert.equal(accepted("deploy.md"), "deploy.md");
    });

    it("never lets a path escape the subtree", () => {
      // A path that looks like a sibling of the subtree is placed UNDER it, not beside it.
      assert.equal(accepted("kb-other/x.md", "kb"), "kb/kb-other/x.md");
      assert.match(rejected("kb/../x.md", "kb"), /\.\./);
      assert.match(rejected("../.github/workflows/ci.md", "kb"), /\.\./);
    });

    it("is case-sensitive about the subtree prefix (a differently-cased prefix nests inside)", () => {
      assert.equal(accepted("KB/x.md", "kb"), "kb/KB/x.md");
    });
  });
});

describe("findUnsafeChangesetPath", () => {
  it("returns undefined for a publishable file-set", () => {
    assert.equal(
      findUnsafeChangesetPath([
        { path: "a.md", content: "# A\n" },
        { path: "nested/b.md", delete: true }
      ]),
      undefined
    );
  });

  it("checks delete targets exactly like writes", () => {
    const unsafe = findUnsafeChangesetPath([
      { path: "a.md", content: "# A\n" },
      { path: "package.json", delete: true }
    ]);
    assert.equal(unsafe?.path, "package.json");
    assert.match(unsafe?.reason ?? "", /\.md/);
  });

  it("reports the first offending entry", () => {
    const unsafe = findUnsafeChangesetPath([
      { path: ".github/workflows/x.yml", content: "on: push" },
      { path: "../y.md", content: "" }
    ]);
    assert.equal(unsafe?.path, ".github/workflows/x.yml");
  });
});
