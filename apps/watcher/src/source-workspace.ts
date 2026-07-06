import { existsSync } from "node:fs";
import path from "node:path";
import type { SourceDescriptor } from "@magpie/core";
import { ensureGitCheckout } from "@magpie/git";
import { draftSeedDocumentInputSchema, type JobView } from "@magpie/jobs";
import { logger } from "./logger.js";

// A resolved, traversable root for one fs-backed source. Both execution tiers
// consume this: the CLI tier as cwd/--add-dir, the tool-loop tier as the
// confinement roots for its read-only tools.
export interface SourceWorkspace {
  sourceId: string;
  name: string;
  rootDir: string;
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

// The source descriptors of a source-grounded job, [] for every other job type.
// Increment 1: seeding only; increments 2-3 add draft_markdown_proposal and the
// patrol jobs here.
export function sourceDescriptorsOf(job: JobView): SourceDescriptor[] {
  if (job.type !== "draft_seed_document") {
    return [];
  }
  const parsed = draftSeedDocumentInputSchema.safeParse(job.input);
  return parsed.success ? parsed.data.sources : [];
}

// Resolves source descriptors to workspaces on the shared checkout volume — the
// same volume and ensureGitCheckout plumbing the publication runner uses for
// destinations, so API and watcher share one checkout per source id. Fails loudly
// when fs sources were configured but NONE resolved: a seed drafted with zero real
// source access is exactly the silent-placeholder failure this feature removes.
export async function prepareSourceWorkspaces(
  descriptors: SourceDescriptor[],
  options: { checkoutRoot: string; checkout?: typeof ensureGitCheckout }
): Promise<PreparedSources> {
  const checkout = options.checkout ?? ensureGitCheckout;
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
      const rootDir =
        descriptor.kind === "git"
          ? withSubpath((await checkout({ id: descriptor.id, url: descriptor.url, checkoutRoot: options.checkoutRoot })).localPath, descriptor.subpath)
          : withSubpath(descriptor.path, descriptor.subpath);
      if (!existsSync(rootDir)) {
        throw new Error(`resolved root does not exist: ${rootDir}`);
      }
      workspaces.push({ sourceId: descriptor.id, name: descriptor.name, rootDir });
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
