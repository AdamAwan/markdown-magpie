import { parseMarkdownDocument, splitIntoSections } from "./index.js";

// The conflict marker: the in-document record that Magpie found the SOURCES
// disagreeing about something this section asserts.
//
// Annotation is deliberately insert-only — the surrounding prose is left exactly
// as it was. Rewriting the disputed sentence would need an AI pass (a cost and a
// hallucination surface) to remove a value the callout directly above it already
// contradicts in place.
//
// The HTML-comment delimiters render invisibly and give the repair step an
// exact, deterministic removal target, so insert/strip are true inverses.
const OPEN = (conflictId: string): string => `<!-- magpie:conflict id=${conflictId} -->`;
const CLOSE = "<!-- /magpie:conflict -->";

export interface ConflictMarkerArgs {
  conflictId: string;
  // Section anchor as splitIntoSections derives it — the slugified heading PATH
  // (a "## Retention" under "# Logging" is "logging-retention"), not the leaf.
  anchor: string;
  summary: string;
}

export function hasConflictMarker(content: string, conflictId: string): boolean {
  return content.includes(OPEN(conflictId));
}

// Renders the marker block. The summary is source-derived (untrusted) text, so
// every line is forced into the blockquote: a summary containing newlines could
// otherwise break out and inject arbitrary Markdown into the published document.
function renderMarker({ conflictId, summary }: ConflictMarkerArgs): string {
  const [first = "", ...rest] = summary.split(/\r?\n/);
  return [
    OPEN(conflictId),
    `> **Unresolved source conflict.** ${first}`.trimEnd(),
    ...rest.map((line) => `> ${line}`.trimEnd()),
    CLOSE
  ].join("\n");
}

// Inserts the marker immediately after the target section's heading line.
//
// Idempotent by conflict id: a document already carrying this conflict's marker
// is returned unchanged. That is what stops the annotate → content changes →
// re-verify → re-annotate loop, and it is enforced here rather than left to the
// model.
//
// An anchor that names no live heading appends the marker at the end of the
// document rather than dropping it — a misplaced conflict notice is recoverable,
// a silently discarded one is not.
export function insertConflictMarker(content: string, args: ConflictMarkerArgs): string {
  if (hasConflictMarker(content, args.conflictId)) {
    return content;
  }
  const marker = renderMarker(args);
  const line = findAnchorHeadingLine(content, args.anchor);
  if (line === undefined) {
    return `${content.replace(/\n*$/, "")}\n\n${marker}\n`;
  }
  const lines = content.split("\n");
  lines.splice(line + 1, 0, "", marker);
  return lines.join("\n");
}

// Removes one conflict's marker block, leaving every other conflict's marker in
// place. Exactly inverts insertConflictMarker.
export function stripConflictMarker(content: string, conflictId: string): string {
  const open = OPEN(conflictId);
  const lines = content.split("\n");
  const start = lines.indexOf(open);
  if (start === -1) {
    return content;
  }
  let end = start;
  while (end < lines.length && lines[end] !== CLOSE) {
    end += 1;
  }
  if (end === lines.length) {
    return content;
  }
  // Insert added a blank separator line before the block; take it back with the
  // block so a strip round-trips to the original bytes.
  const from = start > 0 && lines[start - 1] === "" ? start - 1 : start;
  lines.splice(from, end - from + 1);
  return lines.join("\n");
}

// Line index (0-based, into the FULL content including any frontmatter) of the
// heading whose section anchor matches.
//
// Anchors come from splitIntoSections rather than being re-derived here: the
// package's own comment on slugify warns that a second copy of the anchor rule
// will drift. Sections that carry a heading appear in document order and each
// starts with exactly one heading line, so zipping them against the body's
// heading lines maps anchor → line without duplicating the derivation.
function findAnchorHeadingLine(content: string, anchor: string): number | undefined {
  const parsed = parseMarkdownDocument(content);
  const frontmatterLines = content.split("\n").length - parsed.body.split("\n").length;
  const sections = splitIntoSections({
    id: "conflict-marker",
    repositoryId: "conflict-marker",
    path: "conflict-marker.md",
    metadata: parsed.metadata,
    content
  });

  const headingLines: number[] = [];
  let inFence = false;
  parsed.body.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence && /^(#{1,6})\s+(.+)$/.test(line)) {
      headingLines.push(index);
    }
  });

  const headed = sections.filter((section) => /^(#{1,6})\s+/.test(section.content));
  const position = headed.findIndex((section) => section.anchor === anchor);
  if (position === -1 || position >= headingLines.length) {
    return undefined;
  }
  return headingLines[position] + frontmatterLines;
}
