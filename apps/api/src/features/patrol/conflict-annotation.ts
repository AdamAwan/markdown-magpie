import type { DetectedSourceConflict, ResolvedSourceConflict, SourceDescriptor } from "@magpie/core";
import { hasConflictMarker, insertConflictMarker, stripConflictMarker } from "@magpie/markdown";
import type { AppContext } from "../../context.js";
import type { SourceConflict } from "../../stores/source-conflict-store.js";
import { logger } from "../../logger.js";
import type { CorrectDocumentFn } from "./service.js";

// The conflict half of the correctness patrol: what happens to a document once
// the verify agent reports that its SOURCES disagree.
//
// Nothing here adjudicates. A new conflict is recorded and the document is
// annotated so it stops silently asserting a disputed value; a conflict the
// agent later reports the sources agreeing on is closed and the document
// repaired. Choosing between two sources is a human's job, done by changing the
// sources — never Magpie's, done by changing the document.

export interface AnnotateConflictArgs {
  flowId: string | undefined;
  conflict: DetectedSourceConflict & { path: string };
  content: string;
  destinationId: string | undefined;
}

// Records one detected conflict and, when it is genuinely new, opens an
// annotation proposal for the document.
//
// Returns the stored conflict so the caller can report it. Best-effort by
// design: an annotation that fails to publish leaves an open register entry,
// which is still the visibility the feature exists to provide.
export async function annotateConflict(ctx: AppContext, args: AnnotateConflictArgs): Promise<SourceConflict> {
  const { conflict } = await ctx.stores.sourceConflicts.upsert({
    flowId: args.flowId,
    documentPath: args.conflict.path,
    anchor: args.conflict.anchor,
    topic: args.conflict.topic,
    summary: args.conflict.summary,
    claim: args.conflict.claim,
    positions: args.conflict.positions
  });

  // Three independent reasons not to annotate, all of which must hold for the
  // loop to stay closed:
  //  - the conflict was already recorded (a re-sighting on a later patrol tick),
  //  - the document already carries this conflict's marker,
  //  - the conflict is no longer open (dismissed or resolved).
  // The marker check is the one that matters most: annotating changes the
  // document, which re-arms the change gate, so the next tick re-verifies and
  // the agent reads its own marker.
  if (conflict.status !== "open" || conflict.annotatedProposalId || hasConflictMarker(args.content, conflict.id)) {
    return conflict;
  }

  const markdown = insertConflictMarker(args.content, {
    conflictId: conflict.id,
    anchor: conflict.anchor,
    summary: conflict.summary
  });
  if (markdown === args.content) {
    return conflict;
  }

  const proposal = await ctx.stores.proposals.create({
    title: `Conflict: ${conflict.topic} in ${conflict.documentPath}`,
    targetPath: conflict.documentPath,
    markdown,
    rationale: conflictRationale(conflict),
    evidence: [],
    flowId: args.flowId,
    destinationId: args.destinationId
  });
  await ctx.stores.sourceConflicts.recordAnnotation(conflict.id, proposal.id);

  // Conflicts deliberately skip the reconcile gate. An annotation targets a
  // section no corrective proposal is competing for, and routing it through the
  // gate would let an unrelated open PR defer the marker indefinitely — leaving
  // the document asserting a value Magpie knows is disputed.
  await ctx.stores.gapClusters.enqueuePublicationAction(proposal.id, "publish");
  logger.info(
    { conflictId: conflict.id, proposalId: proposal.id, path: conflict.documentPath },
    "source conflict: annotated document"
  );
  return conflict;
}

// The PR body for an annotation. Source paths appear HERE, in the proposal
// rationale, and never in the document body the marker writes (#214): internal
// repository paths must not reach published content.
function conflictRationale(conflict: SourceConflict): string {
  const positions = conflict.positions
    .map(
      (position) =>
        `- \`${position.sourceId}\` · \`${position.path}\`${lineHint(position.lines)}: ${position.statement}`
    )
    .join("\n");
  return [
    `The sources disagree about **${conflict.topic}**, which this document asserts.`,
    "",
    conflict.summary,
    "",
    "Positions found in the sources:",
    positions,
    "",
    "This change only records the disagreement in the document. Magpie does not choose between sources — resolve the conflict in the sources themselves, and the next correctness patrol will remove this notice and restate the agreed value."
  ].join("\n");
}

function lineHint(lines: string | undefined): string {
  return lines ? ` (${lines})` : "";
}

export interface RepairResolvedConflictArgs {
  flowId: string | undefined;
  resolved: ResolvedSourceConflict & { path: string };
  content: string;
  destinationId: string | undefined;
  sources: SourceDescriptor[];
  correctDocument: CorrectDocumentFn;
}

// Closes a conflict the agent reported the sources now agree on, and repairs the
// document: strip the marker deterministically, then let correct_document
// restate the value against the (now consistent) sources. Reusing the corrective
// job means the repair is an ordinary corrective proposal with its own
// provenance — no new job type, no second code path to keep correct.
export async function repairResolvedConflict(ctx: AppContext, args: RepairResolvedConflictArgs): Promise<boolean> {
  const existing = await ctx.stores.sourceConflicts.get(args.resolved.id);
  if (!existing || existing.status !== "open") {
    // A conflict a human dismissed while the verify job was in flight, or an id
    // the model invented. Neither is worth acting on.
    return false;
  }
  await ctx.stores.sourceConflicts.resolve(args.resolved.id, args.resolved.agreedStatement);

  const stripped = stripConflictMarker(args.content, args.resolved.id);
  await args.correctDocument(ctx, {
    path: existing.documentPath,
    content: stripped,
    claims: [
      {
        claim: existing.claim,
        reason: `sources previously disagreed; they now agree: ${args.resolved.agreedStatement}`
      }
    ],
    sources: args.sources,
    destinationId: args.destinationId,
    flowId: args.flowId
  });
  logger.info(
    { conflictId: existing.id, path: existing.documentPath },
    "source conflict: sources agree again, repairing document"
  );
  return true;
}
