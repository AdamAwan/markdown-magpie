import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionnaireItem } from "@magpie/core";
import type { SectionFingerprint } from "../../stores/postgres-knowledge-store.js";
import { checkReuse, type ReuseCheckDeps } from "./reuse-check.js";

const ANSWERED_AT = "2026-04-12T09:00:00.000Z";
const BEFORE_ANSWER = "2026-01-01T00:00:00.000Z";
const AFTER_ANSWER = "2026-06-03T00:00:00.000Z";

function priorItem(overrides: Partial<QuestionnaireItem> = {}): QuestionnaireItem {
  return {
    id: "prior-item",
    questionnaireId: "prior-questionnaire",
    position: 0,
    question: "What certificates does the product hold?",
    status: "approved",
    answer: "ISO 27001 and SOC 2.",
    answeredAt: ANSWERED_AT,
    staleAtApproval: false,
    citations: [
      { sectionId: "sec-iso", contentHash: "hash-iso", path: "certs/iso.md", heading: "ISO", excerpt: "…" },
      { sectionId: "sec-soc", contentHash: "hash-soc", path: "certs/soc.md", heading: "SOC", excerpt: "…" }
    ],
    ...overrides
  };
}

function fingerprint(sectionId: string, contentHash: string, contentChangedAt: string): SectionFingerprint {
  return { sectionId, contentHash, contentChangedAt };
}

function deps(overrides: Partial<ReuseCheckDeps> = {}): ReuseCheckDeps {
  return {
    // Default world: both cited sections unchanged, retrieval returns only them.
    async fingerprints(sectionIds) {
      const all = [
        fingerprint("sec-iso", "hash-iso", BEFORE_ANSWER),
        fingerprint("sec-soc", "hash-soc", BEFORE_ANSWER)
      ];
      return all.filter((entry) => sectionIds.includes(entry.sectionId));
    },
    async retrieveTopK() {
      return [
        { sectionId: "sec-iso", path: "certs/iso.md", heading: "ISO" },
        { sectionId: "sec-soc", path: "certs/soc.md", heading: "SOC" }
      ];
    },
    ...overrides
  };
}

test("reuses verbatim when cited sections are unchanged and nothing newer is relevant", async () => {
  const decision = await checkReuse(deps(), priorItem(), "What certificates does the product hold?");
  assert.deepEqual(decision, { reuse: true });
});

test("refuses reuse when a cited section's content changed", async () => {
  const decision = await checkReuse(
    deps({
      async fingerprints(sectionIds) {
        const all = [
          fingerprint("sec-iso", "hash-iso-EDITED", AFTER_ANSWER),
          fingerprint("sec-soc", "hash-soc", BEFORE_ANSWER)
        ];
        return all.filter((entry) => sectionIds.includes(entry.sectionId));
      }
    }),
    priorItem(),
    "What certificates does the product hold?"
  );
  assert.equal(decision.reuse, false);
  if (decision.reuse) throw new Error("unreachable");
  assert.equal(decision.reason.kind, "section_changed");
  assert.equal(decision.reason.sectionId, "sec-iso");
  assert.equal(decision.reason.changedAt, AFTER_ANSWER);
});

test("refuses reuse when a cited section no longer exists", async () => {
  const decision = await checkReuse(
    deps({
      async fingerprints(sectionIds) {
        // sec-soc has vanished (re-index removed it).
        return [fingerprint("sec-iso", "hash-iso", BEFORE_ANSWER)].filter((entry) =>
          sectionIds.includes(entry.sectionId)
        );
      }
    }),
    priorItem(),
    "What certificates does the product hold?"
  );
  assert.equal(decision.reuse, false);
  if (decision.reuse) throw new Error("unreachable");
  assert.equal(decision.reason.kind, "section_missing");
  assert.equal(decision.reason.sectionId, "sec-soc");
});

test("refuses reuse when retrieval surfaces content newer than the answer (the new-cert case)", async () => {
  const decision = await checkReuse(
    deps({
      async fingerprints(sectionIds) {
        const all = [
          fingerprint("sec-iso", "hash-iso", BEFORE_ANSWER),
          fingerprint("sec-soc", "hash-soc", BEFORE_ANSWER),
          // The newcomer: indexed after the prior answer was generated.
          fingerprint("sec-csa", "hash-csa", AFTER_ANSWER)
        ];
        return all.filter((entry) => sectionIds.includes(entry.sectionId));
      },
      async retrieveTopK() {
        return [
          { sectionId: "sec-iso", path: "certs/iso.md", heading: "ISO" },
          { sectionId: "sec-csa", path: "certs/csa-star.md", heading: "CSA STAR" },
          { sectionId: "sec-soc", path: "certs/soc.md", heading: "SOC" }
        ];
      }
    }),
    priorItem(),
    "What certificates does the product hold?"
  );
  assert.equal(decision.reuse, false);
  if (decision.reuse) throw new Error("unreachable");
  assert.equal(decision.reason.kind, "new_content");
  assert.equal(decision.reason.sectionId, "sec-csa");
  assert.equal(decision.reason.path, "certs/csa-star.md");
});

test("old sections re-shuffling in the ranking never trigger a refresh", async () => {
  const decision = await checkReuse(
    deps({
      async retrieveTopK() {
        // Different order + an extra OLD section that was not cited.
        return [
          { sectionId: "sec-soc", path: "certs/soc.md", heading: "SOC" },
          { sectionId: "sec-old-other", path: "docs/other.md", heading: "Other" },
          { sectionId: "sec-iso", path: "certs/iso.md", heading: "ISO" }
        ];
      },
      async fingerprints(sectionIds) {
        const all = [
          fingerprint("sec-iso", "hash-iso", BEFORE_ANSWER),
          fingerprint("sec-soc", "hash-soc", BEFORE_ANSWER),
          fingerprint("sec-old-other", "hash-other", BEFORE_ANSWER)
        ];
        return all.filter((entry) => sectionIds.includes(entry.sectionId));
      }
    }),
    priorItem(),
    "What certificates does the product hold?"
  );
  assert.deepEqual(decision, { reuse: true });
});

test("never reuses an item with no citations, no answeredAt, or stale-at-approval", async () => {
  const noCitations = await checkReuse(deps(), priorItem({ citations: [] }), "q");
  assert.equal(noCitations.reuse, false);

  const noAnsweredAt = await checkReuse(deps(), priorItem({ answeredAt: undefined }), "q");
  assert.equal(noAnsweredAt.reuse, false);

  const stale = await checkReuse(deps(), priorItem({ staleAtApproval: true }), "q");
  assert.equal(stale.reuse, false);
});

test("a retrieval failure forbids reuse rather than assuming completeness", async () => {
  const decision = await checkReuse(
    deps({
      async retrieveTopK() {
        return undefined;
      }
    }),
    priorItem(),
    "q"
  );
  assert.equal(decision.reuse, false);
  if (decision.reuse) throw new Error("unreachable");
  assert.equal(decision.reason.kind, "new_content");
});
