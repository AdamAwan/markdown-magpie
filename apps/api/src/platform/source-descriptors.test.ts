import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectSourceDescriptors } from "./source-descriptors.js";
import type { RepositoryDeps } from "./repositories.js";

function depsWith(sources: RepositoryDeps["knowledgeConfig"]["sources"]): RepositoryDeps {
  return { knowledgeConfig: { sources }, checkoutRoot: "/tmp/checkouts" } as RepositoryDeps;
}

describe("projectSourceDescriptors", () => {
  it("projects each configured kind to its descriptor shape", () => {
    const deps = depsWith([
      { id: "g", name: "Repo", kind: "git", url: "https://example.com/r.git", subpath: "Docs" },
      { id: "l", name: "Notes", kind: "local", path: "/srv/notes" },
      { id: "i", name: "Site", kind: "internet", url: "https://x.example" },
      { id: "a", name: "Agent", kind: "agent" }
    ]);
    assert.deepEqual(projectSourceDescriptors(deps, ["g", "l", "i", "a"]), [
      { id: "g", name: "Repo", kind: "git", url: "https://example.com/r.git", subpath: "Docs" },
      { id: "l", name: "Notes", kind: "local", path: "/srv/notes" },
      { id: "i", name: "Site", kind: "internet", url: "https://x.example" },
      { id: "a", name: "Agent", kind: "agent" }
    ]);
  });

  it("defaults to the first three configured sources when no ids are requested", () => {
    const deps = depsWith(
      ["a", "b", "c", "d"].map((id) => ({ id, name: id, kind: "local" as const, path: `/srv/${id}` }))
    );
    assert.deepEqual(
      projectSourceDescriptors(deps, undefined).map((d) => d.id),
      ["a", "b", "c"]
    );
  });

  it("skips a git source with no resolvable url and a local source with no path", () => {
    const deps = depsWith([
      { id: "bad-git", name: "x", kind: "git" },
      { id: "bad-local", name: "y", kind: "local" }
    ]);
    assert.deepEqual(projectSourceDescriptors(deps, ["bad-git", "bad-local"]), []);
  });
});
