import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { SourceDescriptor } from "@magpie/core";
import { hasFsSources, prepareSourceWorkspaces } from "./source-workspace.js";

const git = (over: Partial<Extract<SourceDescriptor, { kind: "git" }>> = {}): SourceDescriptor => ({
  id: "g1", name: "Repo", kind: "git", url: "https://example.com/r.git", ...over
});

describe("prepareSourceWorkspaces", () => {
  it("checks out git sources and roots them at the subpath", async () => {
    const checkoutRoot = mkdtempSync(path.join(tmpdir(), "magpie-ws-"));
    const cloned = path.join(checkoutRoot, "g1");
    mkdirSync(path.join(cloned, "Docs"), { recursive: true });
    const checkout = async (req: { id: string; url: string; checkoutRoot: string }) => {
      assert.equal(req.id, "g1");
      assert.equal(req.url, "https://example.com/r.git");
      return { localPath: cloned, remoteUrl: req.url };
    };
    const prepared = await prepareSourceWorkspaces([git({ subpath: "Docs" })], { checkoutRoot, checkout });
    assert.deepEqual(prepared.workspaces, [{ sourceId: "g1", name: "Repo", rootDir: path.join(cloned, "Docs") }]);
    assert.deepEqual(prepared.notes, []);
  });

  it("uses local sources in place and notes internet/agent sources", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "magpie-local-"));
    writeFileSync(path.join(dir, "readme.md"), "hi");
    const prepared = await prepareSourceWorkspaces(
      [
        { id: "l1", name: "Notes", kind: "local", path: dir },
        { id: "i1", name: "Site", kind: "internet", url: "https://x.example" },
        { id: "a1", name: "Agent", kind: "agent" }
      ],
      { checkoutRoot: dir }
    );
    assert.deepEqual(prepared.workspaces, [{ sourceId: "l1", name: "Notes", rootDir: dir }]);
    assert.equal(prepared.notes.length, 2);
    assert.match(prepared.notes[0]!, /https:\/\/x\.example/);
  });

  it("degrades to a note when one fs source fails but another resolves", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "magpie-partial-"));
    const failing = async () => {
      throw new Error("clone failed");
    };
    const prepared = await prepareSourceWorkspaces(
      [git(), { id: "l1", name: "Notes", kind: "local", path: dir }],
      { checkoutRoot: dir, checkout: failing }
    );
    assert.equal(prepared.workspaces.length, 1);
    assert.equal(prepared.notes.length, 1);
    assert.match(prepared.notes[0]!, /Repo.*unavailable/i);
  });

  it("throws when fs sources are configured but none resolve", async () => {
    const failing = async () => {
      throw new Error("clone failed");
    };
    await assert.rejects(
      prepareSourceWorkspaces([git()], { checkoutRoot: tmpdir(), checkout: failing }),
      /no source workspace could be prepared/i
    );
  });

  it("hasFsSources is true only for git/local descriptors", () => {
    assert.equal(hasFsSources([{ id: "a", name: "a", kind: "agent" }]), false);
    assert.equal(hasFsSources([git()]), true);
  });
});
