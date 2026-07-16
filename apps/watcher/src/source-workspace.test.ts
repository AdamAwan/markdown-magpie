import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { SourceDescriptor } from "@magpie/core";
import type { JobView } from "@magpie/jobs";
import {
  fetchSourceMapEntries,
  hasFsSources,
  prepareSourceWorkspaces,
  sourceDescriptorsOf,
  stampSourceMapUpdates
} from "./source-workspace.js";

const git = (over: Partial<Extract<SourceDescriptor, { kind: "git" }>> = {}): SourceDescriptor => ({
  id: "g1",
  name: "Repo",
  kind: "git",
  url: "https://example.com/r.git",
  ...over
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

  it("captures the checkout head sha on the workspace", async () => {
    const checkoutRoot = mkdtempSync(path.join(tmpdir(), "magpie-ws-"));
    const cloned = path.join(checkoutRoot, "g1");
    mkdirSync(cloned, { recursive: true });
    const checkout = async (req: { id: string; url: string; checkoutRoot: string }) => ({
      localPath: cloned,
      remoteUrl: req.url
    });
    const prepared = await prepareSourceWorkspaces([git()], {
      checkoutRoot,
      checkout,
      headSha: async () => "abc123"
    });
    assert.equal(prepared.workspaces[0]?.headSha, "abc123");
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
    assert.deepEqual(prepared.fetchable, []);
  });

  it("collects allowlisted internet sources as fetchable instead of noting them (#242)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "magpie-local-"));
    const prepared = await prepareSourceWorkspaces(
      [
        { id: "l1", name: "Notes", kind: "local", path: dir },
        {
          id: "i1",
          name: "Vendor docs",
          kind: "internet",
          url: "https://docs.x.example/start",
          allowedHosts: ["docs.x.example"]
        },
        { id: "i2", name: "Ref only", kind: "internet", url: "https://ref.example" }
      ],
      { checkoutRoot: dir }
    );
    assert.deepEqual(prepared.fetchable, [
      { sourceId: "i1", name: "Vendor docs", url: "https://docs.x.example/start", allowedHosts: ["docs.x.example"] }
    ]);
    // The fetchable source is rendered by the prompt builder per tier, so it
    // must NOT also degrade to a reference-only note; the unlisted one still does.
    assert.equal(prepared.notes.length, 1);
    assert.match(prepared.notes[0]!, /Ref only.*reference only/);
  });

  it("degrades to a note when one fs source fails but another resolves", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "magpie-partial-"));
    const failing = async () => {
      throw new Error("clone failed");
    };
    const prepared = await prepareSourceWorkspaces([git(), { id: "l1", name: "Notes", kind: "local", path: dir }], {
      checkoutRoot: dir,
      checkout: failing
    });
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

describe("fetchSourceMapEntries", () => {
  const ws = { sourceId: "s1", name: "S1", rootDir: "/tmp/s1" };

  it("returns the api's entries for the workspace source ids", async () => {
    const seen: string[][] = [];
    const api = {
      sourceMapEntries: async (ids: string[]) => {
        seen.push(ids);
        return [];
      }
    };
    await fetchSourceMapEntries(api, [ws]);
    assert.deepEqual(seen, [["s1"]]);
  });

  it("degrades to no hints when the api is absent or the call fails", async () => {
    assert.deepEqual(await fetchSourceMapEntries(undefined, [ws]), []);
    const failing = {
      sourceMapEntries: async (): Promise<never> => {
        throw new Error("boom");
      }
    };
    assert.deepEqual(await fetchSourceMapEntries(failing, [ws]), []);
  });
});

describe("sourceDescriptorsOf", () => {
  const jobOf = (type: JobView["type"], input: unknown): JobView => ({
    id: "j1",
    type,
    queueName: type,
    deadLetter: false,
    state: "active",
    input,
    retryCount: 0,
    retryLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expireInSeconds: 300
  });

  it("yields a seed job's descriptors", () => {
    const sources = [git()];
    const job = jobOf("draft_seed_document", {
      provider: "openai-compatible",
      flowId: "f1",
      coverage: ["statement ingestion"],
      sources
    });
    assert.deepEqual(sourceDescriptorsOf(job), sources);
  });

  it("yields [] for a non-source-grounded job type", () => {
    const job = jobOf("answer_question", {
      provider: "openai-compatible",
      question: "How do I deploy?",
      flows: [{ id: "f1", name: "Flow" }],
      expectedOutput: "answer_result"
    });
    assert.deepEqual(sourceDescriptorsOf(job), []);
  });

  it("yields [] for a malformed seed input", () => {
    const job = jobOf("draft_seed_document", { provider: "openai-compatible", flowId: "f1" });
    assert.deepEqual(sourceDescriptorsOf(job), []);
  });

  it("yields an outline job's descriptors", () => {
    const sources = [git()];
    const job = jobOf("outline_flow_seed", {
      provider: "openai-compatible",
      flowId: "f1",
      origin: "manual",
      sources,
      existingDocuments: []
    });
    assert.deepEqual(sourceDescriptorsOf(job), sources);
  });

  it("yields a gap-draft job's descriptors", () => {
    const sources = [git()];
    const job = jobOf("draft_markdown_proposal", {
      provider: "openai-compatible",
      gapSummaries: ["refunds"],
      triggeringQuestions: [],
      evidence: [],
      sources,
      expectedOutput: "markdown_proposal"
    });
    assert.deepEqual(sourceDescriptorsOf(job), sources);
  });

  it("yields [] for a malformed gap-draft input", () => {
    const job = jobOf("draft_markdown_proposal", { provider: "openai-compatible" });
    assert.deepEqual(sourceDescriptorsOf(job), []);
  });

  it("returns descriptors for the patrol child jobs", () => {
    const sources = [git({ id: "s1" })];
    const verify = jobOf("verify_document", {
      provider: "openai-compatible",
      path: "kb/a.md",
      content: "# A",
      sources
    });
    const correct = jobOf("correct_document", {
      provider: "openai-compatible",
      path: "kb/a.md",
      content: "# A",
      claims: [{ claim: "x", reason: "y" }],
      sources
    });
    const improve = jobOf("improve_document", {
      provider: "openai-compatible",
      path: "kb/a.md",
      content: "# A",
      sources
    });
    for (const job of [verify, correct, improve]) {
      assert.deepEqual(
        sourceDescriptorsOf(job).map((s) => s.id),
        ["s1"]
      );
    }
  });

  it("returns [] for a malformed verify_document input and for non-grounded types", () => {
    const malformed = jobOf("verify_document", { provider: "openai-compatible" });
    assert.deepEqual(sourceDescriptorsOf(malformed), []);
    const dedupe = jobOf("dedupe_documents", {
      provider: "openai-compatible",
      path: "a",
      content: "x",
      neighbours: []
    });
    assert.deepEqual(sourceDescriptorsOf(dedupe), []);
  });
});

describe("stampSourceMapUpdates", () => {
  const workspaces = [{ sourceId: "s1", name: "S1", rootDir: "/tmp/s1", headSha: "real-sha" }];
  const update = { sourceId: "s1", topic: "t", paths: ["p/"], description: "d" };

  it("overwrites a model-supplied observedSha with the workspace sha", () => {
    const stamped = stampSourceMapUpdates(
      { verdict: "healthy", claims: [], mapUpdates: [{ ...update, observedSha: "model-lie" }] },
      workspaces
    );
    assert.deepEqual(stamped, {
      verdict: "healthy",
      claims: [],
      mapUpdates: [{ ...update, observedSha: "real-sha" }]
    });
  });

  it("removes observedSha when the workspace sha is unknown", () => {
    const stamped = stampSourceMapUpdates(
      { verdict: "healthy", claims: [], mapUpdates: [{ ...update, observedSha: "model-lie" }] },
      [{ sourceId: "s1", name: "S1", rootDir: "/tmp/s1" }]
    );
    assert.deepEqual(stamped, { verdict: "healthy", claims: [], mapUpdates: [update] });
  });

  it("strips observedSha when the update's sourceId matches no workspace", () => {
    const foreign = { ...update, sourceId: "s-unknown" };
    const stamped = stampSourceMapUpdates(
      { verdict: "healthy", claims: [], mapUpdates: [{ ...foreign, observedSha: "model-lie" }] },
      workspaces
    );
    assert.deepEqual(stamped, { verdict: "healthy", claims: [], mapUpdates: [foreign] });
  });

  it("passes through outputs without mapUpdates", () => {
    const output = { verdict: "healthy", claims: [] };
    assert.equal(stampSourceMapUpdates(output, workspaces), output);
  });
});
