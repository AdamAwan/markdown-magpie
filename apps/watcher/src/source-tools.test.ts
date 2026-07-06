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

  it("treats grep queries as literal text, not regex", async () => {
    const { root, workspaces } = fixture();
    // With regex matching, "(a+)+$" against this line backtracks catastrophically.
    writeFileSync(path.join(root, "redos.md"), `${"a".repeat(64)}b`);
    writeFileSync(path.join(root, "notes.md"), "version 1.2 shipped\n1x2 grid layout");
    assert.equal(await grepWorkspaces(workspaces, "(a+)+$"), "(no matches)");
    // "." matches only a literal dot, not any character.
    const dotted = await grepWorkspaces(workspaces, "1.2");
    assert.match(dotted, /version 1\.2 shipped/);
    assert.doesNotMatch(dotted, /1x2 grid/);
  });

  it("rejects empty grep queries", async () => {
    const { workspaces } = fixture();
    await assert.rejects(grepWorkspaces(workspaces, ""), SourceToolError);
    await assert.rejects(grepWorkspaces(workspaces, "   "), SourceToolError);
  });

  it("rejects listDir on a file path with a SourceToolError", async () => {
    const { workspaces } = fixture();
    await assert.rejects(listDir(workspaces, "s1/readme.md"), SourceToolError);
  });

  it("rejects readFile on a directory with a text-file name", async () => {
    const { root, workspaces } = fixture();
    mkdirSync(path.join(root, "docs.md"));
    const budget: ToolBudget = { remainingBytes: 1000 };
    await assert.rejects(readFile(workspaces, "s1/docs.md", budget), SourceToolError);
  });

  it("marks truncated listings but not complete ones", async () => {
    const { root, workspaces } = fixture();
    mkdirSync(path.join(root, "many"));
    for (let i = 0; i < 210; i++) {
      writeFileSync(path.join(root, "many", `f${String(i).padStart(3, "0")}.md`), "x");
    }
    assert.match(await listDir(workspaces, "s1/many"), /… \(200 of 210 entries shown\)/);
    assert.doesNotMatch(await listDir(workspaces, "s1/docs"), /entries shown/);
  });

  it("rejects negative and non-integer offsets", async () => {
    const { workspaces } = fixture();
    const budget: ToolBudget = { remainingBytes: 1000 };
    await assert.rejects(readFile(workspaces, "s1/readme.md", budget, -1), SourceToolError);
    await assert.rejects(readFile(workspaces, "s1/readme.md", budget, 1.5), SourceToolError);
  });

  it("refuses files above the size limit", async () => {
    const { root, workspaces } = fixture();
    writeFileSync(path.join(root, "huge.md"), Buffer.alloc(5 * 1024 * 1024 + 1024, 0x61));
    const budget: ToolBudget = { remainingBytes: 1000 };
    await assert.rejects(readFile(workspaces, "s1/huge.md", budget), SourceToolError);
  });

  it("charges the budget in UTF-8 bytes, not chars", async () => {
    const { root, workspaces } = fixture();
    writeFileSync(path.join(root, "euro.md"), "€".repeat(100)); // 100 chars, 300 bytes
    const budget: ToolBudget = { remainingBytes: 10_000 };
    await readFile(workspaces, "s1/euro.md", budget);
    assert.equal(budget.remainingBytes, 10_000 - 300);
  });
});
