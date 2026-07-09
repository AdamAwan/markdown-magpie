import assert from "node:assert/strict";
import { test } from "node:test";
import type { Proposal, ProvenanceClaim } from "@magpie/core";
import { foldProvenanceEvents } from "./provenance.js";

// A minimal merged proposal carrying the given provenance — the fold reads only
// the provenance field, but takes real Proposal rows (Task 1's query output).
function mergedEvent(id: string, provenance?: ProvenanceClaim[]): Proposal {
  return {
    id,
    title: id,
    status: "merged",
    targetPath: "docs/a.md",
    markdown: "# a",
    evidence: [],
    provenance,
    createdAt: "2026-07-01T00:00:00.000Z",
    mergedAt: "2026-07-02T00:00:00.000Z"
  };
}

function claim(text: string, anchor: string | undefined, path = "src/a.ts"): ProvenanceClaim {
  return { claim: text, anchor, sources: [{ sourceId: "src-1", path }] };
}

const CONTENT = "# Deploy\nIntro.\n\n## Rollback\nSteps.\n\n## Flags\nDetails.\n";

test("a single event's claims are returned when their anchors exist in the document", () => {
  const claims = [claim("rollbacks are automatic", "rollback"), claim("flags gate rollout", "flags")];
  const folded = foldProvenanceEvents([mergedEvent("e1", claims)], CONTENT);
  assert.deepEqual(folded, claims);
});

test("a later event supersedes an earlier one per anchor; distinct anchors both survive", () => {
  const first = [claim("rollbacks are manual", "rollback"), claim("flags gate rollout", "flags")];
  const second = [claim("rollbacks are automatic", "rollback", "src/rollback.ts")];
  const folded = foldProvenanceEvents([mergedEvent("e1", first), mergedEvent("e2", second)], CONTENT);
  assert.deepEqual(folded, [claim("flags gate rollout", "flags"), claim("rollbacks are automatic", "rollback", "src/rollback.ts")]);
});

test("claims whose anchor names a heading that no longer exists are dropped; anchor-less claims are kept", () => {
  const claims = [
    claim("rollbacks are automatic", "rollback"),
    claim("this section was removed", "retired-heading"),
    claim("general fact with no section", undefined)
  ];
  const folded = foldProvenanceEvents([mergedEvent("e1", claims)], CONTENT);
  assert.deepEqual(folded, [claim("rollbacks are automatic", "rollback"), claim("general fact with no section", undefined)]);
});

test("accepts both the indexer's heading-path anchor and the plain heading slug", () => {
  // The sectioniser's Citation.anchor for "## Rollback" under "# Deploy" is
  // "deploy-rollback"; the drafting prompt asks for "the slug of the section
  // heading", i.e. "rollback". Both must be recognised as live.
  const claims = [claim("path-form anchor", "deploy-rollback"), claim("plain-form anchor", "rollback")];
  const folded = foldProvenanceEvents([mergedEvent("e1", claims)], CONTENT);
  assert.deepEqual(folded, claims);
});

test("events without provenance contribute nothing and do not error", () => {
  const folded = foldProvenanceEvents(
    [mergedEvent("e1", undefined), mergedEvent("e2", [claim("rollbacks are automatic", "rollback")]), mergedEvent("e3", undefined)],
    CONTENT
  );
  assert.deepEqual(folded, [claim("rollbacks are automatic", "rollback")]);
});

test("no events folds to an empty claim set", () => {
  assert.deepEqual(foldProvenanceEvents([], CONTENT), []);
});

test("output order is deterministic: event order, then within-event order, superseded keys move to the winning event", () => {
  const first = [claim("flags gate rollout", "flags"), claim("rollbacks are manual", "rollback")];
  const second = [claim("deploy is push-button", "deploy"), claim("rollbacks are automatic", "rollback")];
  const folded = foldProvenanceEvents([mergedEvent("e1", first), mergedEvent("e2", second)], CONTENT);
  assert.deepEqual(folded, [
    claim("flags gate rollout", "flags"),
    claim("deploy is push-button", "deploy"),
    claim("rollbacks are automatic", "rollback")
  ]);
});

test("two anchor-less claims with the same text collapse to the latest; different texts both survive", () => {
  // Without an anchor the claim text itself is the supersession key.
  const folded = foldProvenanceEvents(
    [
      mergedEvent("e1", [claim("general fact", undefined), claim("other fact", undefined)]),
      mergedEvent("e2", [claim("general fact", undefined, "src/updated.ts")])
    ],
    CONTENT
  );
  assert.deepEqual(folded, [claim("other fact", undefined), claim("general fact", undefined, "src/updated.ts")]);
});
