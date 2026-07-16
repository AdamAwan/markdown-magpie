// Advisory-register heading detection (#213). Documents this system produces must
// be factual and descriptive; headings like "Recommendations" or "Next steps"
// signal the draft is recommending or planning in its own voice. Matching is a
// FLAG, never a failure: a document may legitimately describe a roadmap a source
// itself states, so consumers warn and surface — they never reject.
const ADVISORY_HEADING_TERMS: readonly string[] = [
  "recommendation",
  "recommendations",
  "next step",
  "next steps",
  "action item",
  "action items",
  "action plan",
  "roadmap",
  "future work",
  "future enhancements",
  "improvement plan",
  "implementation plan",
  "suggested improvements",
  "proposed improvements"
];

// Frontmatter delimiter fence, matched the same way parseMarkdownDocument
// (index.ts) strips it, so frontmatter keys/values are never scanned as
// headings (and the opening/closing "---" never misreads as a setext H2
// underline).
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

// A line that is only "=" characters (optionally trailing spaces) underlines a
// setext H1; only "-" characters underlines a setext H2. Both require at
// least one character above.
const SETEXT_H1_UNDERLINE = /^\s*=+\s*$/;
const SETEXT_H2_UNDERLINE = /^\s*-+\s*$/;

// Scans a markdown document's headings (fence-aware, like splitIntoSections),
// ATX (`#`) and setext (`===`/`---` underline), and returns the original text
// of every heading whose normalised words contain a blocklist term as a whole
// word/phrase. Deduplicated, first-seen order.
export function findAdvisoryHeadings(markdown: string): string[] {
  const headings: string[] = [];
  const body = markdown.replace(FRONTMATTER_PATTERN, "");
  let inFence = false;
  // Text of the most recent non-blank line that hasn't yet been consumed as a
  // heading — the candidate text line for a setext heading. Cleared on blank
  // lines, fence boundaries, and once an ATX or setext heading consumes it,
  // so a standalone thematic break (nothing, or only a blank line, above it)
  // is never mistaken for a setext underline.
  let precedingText: string | null = null;

  const addHeading = (text: string): void => {
    if (isAdvisoryHeading(text) && !headings.includes(text)) {
      headings.push(text);
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      precedingText = null;
      continue;
    }
    if (inFence) {
      precedingText = null;
      continue;
    }

    const atxHeading = /^#{1,6}\s+(.+)$/.exec(line);
    if (atxHeading) {
      addHeading(stripClosedAtxHashes(atxHeading[1].trim()));
      precedingText = null;
      continue;
    }

    if ((SETEXT_H1_UNDERLINE.test(line) || SETEXT_H2_UNDERLINE.test(line)) && precedingText !== null) {
      addHeading(precedingText);
      precedingText = null;
      continue;
    }

    const trimmed = line.trim();
    precedingText = trimmed === "" ? null : trimmed;
  }
  return headings;
}

// Strips CommonMark's optional closed-ATX trailing hash sequence, e.g.
// "Recommendations ##" -> "Recommendations". Requires whitespace before the
// hash run so a trailing "#" that's actually part of the text (e.g. "C#") is
// left untouched.
function stripClosedAtxHashes(text: string): string {
  return text.replace(/\s+#+$/, "");
}

function isAdvisoryHeading(text: string): boolean {
  // Normalise to space-separated lowercase words so terms match as whole
  // words/phrases: "Stepwise processing" must not match "next step", while
  // "Phase 1 roadmap" must match "roadmap".
  const words = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
  return ADVISORY_HEADING_TERMS.some((term) => words.includes(` ${term} `));
}
