import { createHash } from "node:crypto";
import type { SourceDataContext } from "@magpie/core";

// The change gate (#163) compares a document's current content and the flow's
// current source corpus against the hashes recorded the last time the doc was
// checked. Byte-identical on both ⇒ the verdict cannot have changed, so the tick
// skips the (provider-billed) re-check. These helpers produce the two hashes.

// Hash of one document body. Plain SHA-256 of the content — the verify/split
// lenses depend only on the doc text, so this is a faithful change signal.
export function hashDocumentContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Hash of the whole source corpus a flow's lenses check against. Order-independent
// (the per-source digests are sorted) and covers every field the lenses could react
// to — identity plus the actual content — so a source edit re-arms every doc's gate
// while an unrelated re-read that yields identical material does not.
//
// Each source is hashed to a fixed-length digest first, then the sorted digests are
// combined. Because content bodies can contain any character (newlines, NULs), this
// per-source-digest approach avoids any field/row boundary a single flat join could
// make ambiguous.
export function hashSourceCorpus(sources: readonly SourceDataContext[]): string {
  const perSource = sources
    .map((source) =>
      createHash("sha256")
        .update(source.sourceId)
        .update("\0")
        .update(source.kind)
        .update("\0")
        .update(source.path ?? "")
        .update("\0")
        .update(source.url ?? "")
        .update("\0")
        .update(source.content ?? "")
        .digest("hex")
    )
    .sort();
  return createHash("sha256").update(perSource.join("")).digest("hex");
}
