import { existsSync } from "node:fs";
import path from "node:path";
import type { SourceDescriptor, SourceMapEntry } from "@magpie/core";
import { ensureGitCheckout, getHeadSha } from "@magpie/git";
import {
  correctDocumentInputSchema,
  draftMarkdownProposalInputSchema,
  draftSeedDocumentInputSchema,
  improveDocumentInputSchema,
  verifyDocumentInputSchema,
  type JobType,
  type JobView
} from "@magpie/jobs";
import { logger } from "./logger.js";

// A resolved, traversable root for one fs-backed source. Both execution tiers
// consume this: the CLI tier as cwd/--add-dir, the tool-loop tier as the
// confinement roots for its read-only tools.
export interface SourceWorkspace {
  sourceId: string;
  name: string;
  rootDir: string;
  // HEAD of the resolved checkout, when it is a git repo. Best-effort — absent
  // for local-kind sources and any repo whose HEAD could not be read.
  headSha?: string;
}

export interface PreparedSources {
  workspaces: SourceWorkspace[];
  // Prompt lines for sources with no filesystem: internet/agent placeholders and
  // fs sources that failed to resolve (partial degradation, named explicitly).
  notes: string[];
}

export function hasFsSources(descriptors: SourceDescriptor[]): boolean {
  return descriptors.some((d) => d.kind === "git" || d.kind === "local");
}

// The input schema of each source-grounded job type — every input that carries
// `sources: SourceDescriptor[]`. All five arrived with the source-agentic
// grounding increments (seeding, gap drafting, patrols); a type absent here is
// not source-grounded and never routes to the agentic tiers.
function sourceGroundedInputSchema(type: JobType) {
  switch (type) {
    case "draft_seed_document":
      return draftSeedDocumentInputSchema;
    case "draft_markdown_proposal":
      return draftMarkdownProposalInputSchema;
    case "verify_document":
      return verifyDocumentInputSchema;
    case "correct_document":
      return correctDocumentInputSchema;
    case "improve_document":
      return improveDocumentInputSchema;
    default:
      return undefined;
  }
}

// The source descriptors of a source-grounded job, [] for every other job type
// (and for a malformed input — the job then runs the plain one-shot path and
// fails on its own terms rather than here).
export function sourceDescriptorsOf(job: JobView): SourceDescriptor[] {
  const schema = sourceGroundedInputSchema(job.type);
  if (!schema) {
    return [];
  }
  const parsed = schema.safeParse(job.input);
  return parsed.success ? parsed.data.sources : [];
}

// Resolves source descriptors to workspaces on the shared checkout volume — the
// same volume and ensureGitCheckout plumbing the publication runner uses for
// destinations, so API and watcher share one checkout per source id. Fails loudly
// when fs sources were configured but NONE resolved: a seed drafted with zero real
// source access is exactly the silent-placeholder failure this feature removes.
export async function prepareSourceWorkspaces(
  descriptors: SourceDescriptor[],
  options: {
    checkoutRoot: string;
    checkout?: typeof ensureGitCheckout;
    headSha?: (localPath: string) => Promise<string | undefined>;
  }
): Promise<PreparedSources> {
  const checkout = options.checkout ?? ensureGitCheckout;
  const readHeadSha = options.headSha ?? getHeadSha;
  const workspaces: SourceWorkspace[] = [];
  const notes: string[] = [];

  for (const descriptor of descriptors) {
    if (descriptor.kind === "internet") {
      notes.push(
        descriptor.url
          ? `Internet source "${descriptor.name}": ${descriptor.url} (reference only; not fetched).`
          : `Internet source "${descriptor.name}": use relevant internet research as supporting material.`
      );
      continue;
    }
    if (descriptor.kind === "agent") {
      notes.push(`Agent source "${descriptor.name}": use general knowledge as supporting material.`);
      continue;
    }
    try {
      const repoRoot =
        descriptor.kind === "git"
          ? (await checkout({ id: descriptor.id, url: descriptor.url, checkoutRoot: options.checkoutRoot })).localPath
          : descriptor.path;
      const rootDir = withSubpath(repoRoot, descriptor.subpath);
      if (!existsSync(rootDir)) {
        throw new Error(`resolved root does not exist: ${rootDir}`);
      }
      // Best-effort: a local-kind source need not be a git repo, and a sha is only
      // a staleness stamp for map hints — never fail workspace preparation for it.
      let headSha: string | undefined;
      try {
        headSha = await readHeadSha(repoRoot);
      } catch {
        headSha = undefined;
      }
      workspaces.push({ sourceId: descriptor.id, name: descriptor.name, rootDir, ...(headSha ? { headSha } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unavailable";
      logger.warn({ sourceId: descriptor.id, err: message }, "source workspace unavailable");
      notes.push(`Source "${descriptor.name}" is unavailable (${message}).`);
    }
  }

  if (workspaces.length === 0 && hasFsSources(descriptors)) {
    throw new Error("no source workspace could be prepared: every filesystem-backed source failed to resolve");
  }
  return { workspaces, notes };
}

function withSubpath(root: string, subpath: string | undefined): string {
  return subpath ? path.join(root, subpath) : root;
}

// Fetches the source-map hints for the prepared fs workspaces. Best-effort by
// contract: hints are optional context, so an absent api or any failure
// degrades to an empty list rather than failing the job.
export async function fetchSourceMapEntries(
  api: { sourceMapEntries(sourceIds: string[]): Promise<SourceMapEntry[]> } | undefined,
  workspaces: SourceWorkspace[]
): Promise<SourceMapEntry[]> {
  if (!api || workspaces.length === 0) {
    return [];
  }
  try {
    return await api.sourceMapEntries(workspaces.map((ws) => ws.sourceId));
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "source map fetch failed; continuing without hints"
    );
    return [];
  }
}

// Stamps the watcher-observed checkout sha onto every mapUpdate in a parsed
// source-grounded output, overwriting anything the model put there: the sha
// is an infrastructure fact, never trusted from the model. When workspaces is
// EMPTY (the ungrounded fallback path — non-fs sources or the generative
// runner) every update's observedSha is stripped out, because the watcher
// never actually observed the checkout. Outputs without a mapUpdates array
// pass through untouched.
export function stampSourceMapUpdates(output: unknown, workspaces: SourceWorkspace[]): unknown {
  if (typeof output !== "object" || output === null || !("mapUpdates" in output) || !Array.isArray(output.mapUpdates)) {
    return output;
  }
  const shaBySource = new Map(
    workspaces.flatMap((ws) => (ws.headSha ? [[ws.sourceId, ws.headSha] as const] : []))
  );
  const mapUpdates = output.mapUpdates.map((update: unknown) => {
    if (typeof update !== "object" || update === null || !("sourceId" in update) || typeof update.sourceId !== "string") {
      return update;
    }
    const stripped = Object.fromEntries(Object.entries(update).filter(([key]) => key !== "observedSha"));
    const sha = shaBySource.get(update.sourceId);
    return sha ? { ...stripped, observedSha: sha } : stripped;
  });
  return { ...output, mapUpdates };
}
