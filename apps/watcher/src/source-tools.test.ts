import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  grepWorkspaces,
  listDir,
  readFile,
  resolveSourcePath,
  SourceToolError,
  type ToolBudget
} from "./source-tools.js";

function fixture(): { root: string; workspaces: [{ sourceId: string; name: string; rootDir: string }] } {
  const root = mkdtempSync(path.join(tmpdir(), "magpie-tools-"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "readme.md"), "# Statements\ningestion pipeline docs");
  writeFileSync(path.join(root, "docs", "spec.md"), "statement lines match invoices");
  writeFileSync(path.join(root, "app.bin"), Buffer.from([0, 1, 2]));
  return { root, workspaces: [{ sourceId: "s1", name: "Repo", rootDir: root }] };
}

describe("resolveSourcePath", () => {
  it("resolves <sourceId>/<relative> inside the workspace", () => {
    const { root, workspaces } = fixture();
    const resolved = resolveSourcePath(workspaces, "s1/docs/spec.md");
    assert.equal(resolved.absolutePath, path.join(root, "docs", "spec.md"));
  });

  it("rejects traversal, unknown workspaces, and absolute paths", () => {
    const { workspaces } = fixture();
    assert.throws(() => resolveSourcePath(workspaces, "s1/../../etc/passwd"), SourceToolError);
    assert.throws(() => resolveSourcePath(workspaces, "nope/readme.md"), SourceToolError);
    assert.throws(() => resolveSourcePath(workspaces, "/etc/passwd"), SourceToolError);
  });

  it("rejects symlinks that escape the workspace", function (t) {
    const { root, workspaces } = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "magpie-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    try {
      symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    assert.throws(() => resolveSourcePath(workspaces, "s1/link.txt"), SourceToolError);
  });
});

describe("tools", () => {
  it("lists roots for the empty path and entries for a directory", async () => {
    const { workspaces } = fixture();
    assert.match(await listDir(workspaces, ""), /s1\/ {2}\(Repo\)/);
    const listing = await listDir(workspaces, "s1");
    assert.match(listing, /docs\//);
    assert.match(listing, /readme\.md/);
  });

  it("reads text files against the budget and refuses binary files", async () => {
    const { workspaces } = fixture();
    const budget: ToolBudget = { remainingBytes: 1000 };
    const content = await readFile(workspaces, "s1/readme.md", budget);
    assert.match(content, /ingestion pipeline/);
    assert.ok(budget.remainingBytes < 1000);
    await assert.rejects(readFile(workspaces, "s1/app.bin", budget), SourceToolError);
  });

  it("greps across the workspace with match caps", async () => {
    const { workspaces } = fixture();
    const hits = await grepWorkspaces(workspaces, "statement");
    assert.match(hits, /docs\/spec\.md/);
    assert.match(hits, /match invoices/);
  });
});
