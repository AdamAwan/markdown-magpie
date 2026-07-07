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

// Scans a markdown document's headings (fence-aware, like splitIntoSections) and
// returns the original text of every heading whose normalised words contain a
// blocklist term as a whole word/phrase. Deduplicated, first-seen order.
export function findAdvisoryHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (!heading) {
      continue;
    }
    const text = heading[1].trim();
    if (isAdvisoryHeading(text) && !headings.includes(text)) {
      headings.push(text);
    }
  }
  return headings;
}

function isAdvisoryHeading(text: string): boolean {
  // Normalise to space-separated lowercase words so terms match as whole
  // words/phrases: "Stepwise processing" must not match "next step", while
  // "Phase 1 roadmap" must match "roadmap".
  const words = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  return ADVISORY_HEADING_TERMS.some((term) => words.includes(` ${term} `));
}
