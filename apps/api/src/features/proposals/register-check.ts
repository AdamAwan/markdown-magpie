import { findAdvisoryHeadings } from "@magpie/markdown";
import type { ChangesetChange } from "@magpie/core";
import { logger } from "../../logger.js";
import type { ProposalInput } from "../../stores/proposal-store.js";

// Advisory-register check (#213). A draft containing advisory-style headings
// (Recommendations / Next steps / Roadmap / …) is FLAGGED — structured warning +
// reviewer note on the rationale — never hard-failed: a document may legitimately
// describe a roadmap a source itself states, so a human decides.

// Collects advisory headings across a proposal's content: every changeset write
// when a file-set is present, else the primary markdown. Deduplicated across files,
// first-seen order.
export function collectAdvisoryHeadings(markdown: string, changeset?: ChangesetChange[]): string[] {
  const bodies: string[] =
    changeset && changeset.length > 0
      ? changeset.flatMap((change) => (!change.delete && typeof change.content === "string" ? [change.content] : []))
      : [markdown];
  const headings: string[] = [];
  for (const body of bodies) {
    for (const heading of findAdvisoryHeadings(body)) {
      if (!headings.includes(heading)) {
        headings.push(heading);
      }
    }
  }
  return headings;
}

// The reviewer-visible note appended to a flagged proposal's rationale.
export function advisoryNote(headings: string[]): string {
  const quoted = headings.map((heading) => `"${heading}"`).join(", ");
  return (
    `Register check: advisory-style headings detected (${quoted}). Documents must describe what the ` +
    `sources state — verify these sections describe a plan the sources themselves state, not authored ` +
    `recommendations.`
  );
}

// Runs the check over a draft ProposalInput just before it is stored: warns and
// appends the note to the rationale. Returns the input untouched when clean.
export function flagAdvisoryDraft(
  input: ProposalInput,
  context: { jobId?: string; jobType: string }
): ProposalInput {
  const headings = collectAdvisoryHeadings(input.markdown, input.changeset);
  if (headings.length === 0) {
    return input;
  }
  logger.warn(
    { ...context, targetPath: input.targetPath, advisoryHeadings: headings },
    "draft contains advisory-style headings; flagged on the proposal rationale (not blocked)"
  );
  return { ...input, rationale: `${input.rationale}\n\n${advisoryNote(headings)}` };
}
