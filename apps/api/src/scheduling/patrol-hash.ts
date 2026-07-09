import { createHash } from "node:crypto";
import type { ProvenanceClaim, SourceDescriptor } from "@magpie/core";

// The change gate (#163) compares a document's current content and the flow's
// current source configuration against the hashes recorded the last time the doc
// was checked. Byte-identical on both ⇒ the verdict cannot have changed, so the
// tick skips the (provider-billed) re-check. These helpers produce the two hashes.

// Hash of one document body. Plain SHA-256 of the content — the verify/split
// lenses depend only on the doc text, so this is a faithful change signal.
export function hashDocumentContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Hash of the source-descriptor set a flow's lenses are grounded in. Since the
// agentic migration there is no corpus snapshot to fingerprint — the executing
// agent explores live checkouts at job runtime — so the gate re-arms when the
// document body changes or the flow's source *configuration* changes (a source
// added, removed, re-pointed, or re-scoped). A source-content-only change no
// longer busts the gate: an accepted trade-off recorded in the increment-3 plan
// (the old corpus hash only ever saw a 24-file sample anyway, and every check now
// reads current source truth when it runs). Order-independent, and each
// descriptor is digested to fixed length first so no field/row boundary a flat
// join could make ambiguous exists.
export function hashSourceDescriptors(sources: readonly SourceDescriptor[]): string {
  const perSource = sources
    .map((source) =>
      createHash("sha256")
        .update(source.id)
        .update("\0")
        .update(source.kind)
        .update("\0")
        .update(source.name)
        .update("\0")
        .update(source.kind === "git" || source.kind === "internet" ? (source.url ?? "") : "")
        .update("\0")
        .update(source.kind === "local" ? source.path : "")
        .update("\0")
        .update(source.kind === "git" || source.kind === "local" ? (source.subpath ?? "") : "")
        .digest("hex")
    )
    .sort();
  return createHash("sha256").update(perSource.join("")).digest("hex");
}

// Hash of the folded citedClaims a verify job is told about (#214 phase 2), the
// third leg of the verify reuse key: a provenance change after a merge must not
// reuse a verify verdict computed against the old claim set. Same
// digest-per-item pattern as hashSourceDescriptors — with explicit field (\x01)
// / row (\x02) separators inside each claim's source list so no flat join is
// ambiguous — but deliberately order-SENSITIVE, unlike the descriptor hash: the
// fold's output order is deterministic, and two inputs presenting the claims in
// a different order render different prompts.
export function hashProvenanceClaims(claims: readonly ProvenanceClaim[]): string {
  const perClaim = claims.map((claim) =>
    createHash("sha256")
      .update(claim.claim)
      .update("\0")
      .update(claim.anchor ?? "")
      .update("\0")
      .update(
        claim.sources
          .map((source) => [source.sourceId, source.path ?? "", source.lines ?? "", source.url ?? ""].join("\u0001"))
          .join("\u0002")
      )
      .digest("hex")
  );
  return createHash("sha256").update(perClaim.join("")).digest("hex");
}
