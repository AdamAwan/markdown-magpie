import type { SourceDescriptor } from "@magpie/core";
import type { ConfiguredKnowledgeRepository } from "../stores/knowledge-repositories.js";
import type { RepositoryDeps } from "./repositories.js";

// Projects a flow's configured sources into the reference-only descriptors that
// source-grounded job inputs carry. This replaced the API-side file sampling
// (deleted with the corpus pipeline): no content is collected here; the watcher
// resolves these references to traversable workspaces. Selection rules match the
// sampler it replaced: explicit ids filter the configured set; no ids means the
// first three configured sources.
export function projectSourceDescriptors(deps: RepositoryDeps, sourceIds: string[] | undefined): SourceDescriptor[] {
  const selected = selectSources(deps.knowledgeConfig.sources, sourceIds);
  const descriptors: SourceDescriptor[] = [];
  for (const source of selected) {
    const descriptor = toDescriptor(source);
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

function selectSources(
  sources: ConfiguredKnowledgeRepository[],
  sourceIds: string[] | undefined
): ConfiguredKnowledgeRepository[] {
  const requested = new Set((sourceIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (requested.size === 0) {
    return sources.slice(0, 3);
  }
  return sources.filter((source) => requested.has(source.id));
}

// The ids of `descriptors` that are NOT exactly what the API would project from
// the operator's configured sources: an unknown id, or a known id whose kind,
// name, url, path, subpath or fetch allowlist differs from config. Externally
// submitted jobs (POST /api/jobs) are checked with this, because a caller-authored
// descriptor is a direct line to the watcher's filesystem and network — a `local`
// path of `/` makes the agent read host files, a `subpath` can climb out of the
// checkout, an `internet` allowlist can point the fetch tool at internal hosts.
// Only the operator's config may define those. `tokenEnv` is not compared: the
// job input schema strips it (see QueuedSourceDescriptor in @magpie/jobs).
export function unconfiguredSourceDescriptorIds(
  sources: readonly ConfiguredKnowledgeRepository[],
  descriptors: readonly SourceDescriptor[]
): string[] {
  const configured = new Map<string, string>();
  for (const source of sources) {
    const descriptor = toDescriptor(source);
    if (descriptor) {
      configured.set(descriptor.id, descriptorKey(descriptor));
    }
  }
  return descriptors
    .filter((descriptor) => configured.get(descriptor.id) !== descriptorKey(descriptor))
    .map((descriptor) => descriptor.id);
}

// A canonical comparison key over every security-relevant descriptor field. An
// absent allowlist and an empty one are equivalent (both mean "not fetchable").
function descriptorKey(descriptor: SourceDescriptor): string {
  switch (descriptor.kind) {
    case "git":
      return JSON.stringify([
        descriptor.kind,
        descriptor.id,
        descriptor.name,
        descriptor.url,
        descriptor.subpath ?? null
      ]);
    case "local":
      return JSON.stringify([
        descriptor.kind,
        descriptor.id,
        descriptor.name,
        descriptor.path,
        descriptor.subpath ?? null
      ]);
    case "internet":
      return JSON.stringify([
        descriptor.kind,
        descriptor.id,
        descriptor.name,
        descriptor.url ?? null,
        descriptor.allowedHosts ?? []
      ]);
    case "agent":
      return JSON.stringify([descriptor.kind, descriptor.id, descriptor.name]);
  }
}

// A source that cannot be referenced (a git source with no url, a local source
// with no path) is dropped rather than sent as an unresolvable reference.
function toDescriptor(source: ConfiguredKnowledgeRepository): SourceDescriptor | undefined {
  if (source.kind === "git") {
    return source.url
      ? {
          id: source.id,
          name: source.name,
          kind: "git",
          url: source.url,
          ...(source.subpath ? { subpath: source.subpath } : {}),
          // Carry the per-source PAT env var NAME (not the secret) so the watcher
          // clones a source held by a different account with its own token.
          ...(source.tokenEnv ? { tokenEnv: source.tokenEnv } : {})
        }
      : undefined;
  }
  if (source.kind === "local") {
    return source.path
      ? {
          id: source.id,
          name: source.name,
          kind: "local",
          path: source.path,
          ...(source.subpath ? { subpath: source.subpath } : {})
        }
      : undefined;
  }
  if (source.kind === "internet") {
    return {
      id: source.id,
      name: source.name,
      kind: "internet",
      ...(source.url ? { url: source.url } : {}),
      ...(source.allowedHosts && source.allowedHosts.length > 0 ? { allowedHosts: source.allowedHosts } : {})
    };
  }
  return { id: source.id, name: source.name, kind: "agent" };
}
