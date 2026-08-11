import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertedClaimFingerprint, InMemoryAssertedClaimsStore } from "./asserted-claims-store.js";

const base = {
  flowId: "security",
  questionnaireId: "q1",
  itemId: "i1",
  kind: "unsubstantiated" as const,
  question: "Do you hold ISO 27001?",
  claim: "We have held ISO 27001 since 2021.",
  positions: []
};

describe("InMemoryAssertedClaimsStore", () => {
  it("opens a finding and lists it by status and flow", async () => {
    const store = new InMemoryAssertedClaimsStore();
    const { claim, created } = await store.open(base);
    assert.equal(created, true);
    assert.equal(claim.status, "open");
    assert.equal(claim.seenCount, 1);
    assert.equal((await store.list({ status: "open", flowId: "security", limit: 10 })).length, 1);
    assert.equal((await store.list({ status: "open", flowId: "other", limit: 10 })).length, 0);
    assert.equal((await store.list({ status: "resolved", limit: 10 })).length, 0);
  });

  it("re-opening the same fingerprint bumps the sighting instead of duplicating", async () => {
    const store = new InMemoryAssertedClaimsStore();
    const first = await store.open(base);
    const second = await store.open(base);
    assert.equal(second.created, false);
    assert.equal(second.claim.id, first.claim.id);
    assert.equal(second.claim.seenCount, 2);
    assert.equal((await store.list({ limit: 10 })).length, 1);
  });

  it("never resurrects a dismissal on re-detection — the register must stay readable", async () => {
    const store = new InMemoryAssertedClaimsStore();
    const { claim } = await store.open(base);
    await store.dismiss(claim.id, "certificate genuinely lapsed; answer withdrawn");

    const again = await store.open(base);
    assert.equal(again.claim.id, claim.id);
    assert.equal(again.claim.seenCount, 2);
    assert.equal(again.claim.status, "dismissed");
  });

  it("openForItem returns only live findings — the approval gate's query", async () => {
    const store = new InMemoryAssertedClaimsStore();
    const { claim } = await store.open(base);
    assert.equal((await store.openForItem("i1")).length, 1);
    assert.equal((await store.openForItem("other-item")).length, 0);

    await store.resolve(claim.id, "added the certificate to the compliance source repo");
    assert.equal((await store.openForItem("i1")).length, 0);
    assert.equal((await store.get(claim.id))?.resolutionNote, "added the certificate to the compliance source repo");
  });

  it("keeps the two kinds as separate findings for one item", async () => {
    // One answer can be unsubstantiated on one claim and contradicted on
    // another; a reviewer resolves them independently.
    const store = new InMemoryAssertedClaimsStore();
    await store.open(base);
    await store.open({
      ...base,
      kind: "contradicted",
      claim: "Logs are retained for 1 year.",
      positions: [{ sourceId: "policy", path: "security/retention.md", statement: "retained for 60 days" }]
    });
    const open = await store.list({ status: "open", limit: 10 });
    assert.deepEqual(open.map((entry) => entry.kind).sort(), ["contradicted", "unsubstantiated"]);
  });

  it("fingerprints ignore claim casing and whitespace but separate kinds and items", async () => {
    const spaced = assertedClaimFingerprint({ ...base, claim: "  We have HELD   ISO 27001 since 2021. " });
    assert.equal(spaced, assertedClaimFingerprint(base));
    assert.notEqual(assertedClaimFingerprint({ ...base, kind: "contradicted" }), assertedClaimFingerprint(base));
    assert.notEqual(assertedClaimFingerprint({ ...base, itemId: "i2" }), assertedClaimFingerprint(base));
  });

  it("folds an absent flow into the fingerprint as a sentinel, never a blank", async () => {
    // Postgres treats NULLs as distinct in a unique index, so an unscoped
    // finding must still dedupe against itself.
    const store = new InMemoryAssertedClaimsStore();
    const { flowId: _flowId, ...unscoped } = base;
    const first = await store.open(unscoped);
    const second = await store.open(unscoped);
    assert.equal(second.created, false);
    assert.equal(second.claim.id, first.claim.id);
    assert.notEqual(assertedClaimFingerprint(unscoped), assertedClaimFingerprint(base));
  });
});
