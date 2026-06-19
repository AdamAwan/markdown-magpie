import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureGitCheckout } from "@magpie/git";
import type { RepositoryRef } from "@magpie/core";
import {
  type ConfiguredKnowledgeFlow,
  type ConfiguredKnowledgeRepository,
  resolveConfiguredRepositorySelection,
  resolveKnowledgeRepositorySelection
} from "../stores/knowledge-repositories.js";
import type { InMemoryKnowledgeIndex } from "../stores/knowledge-index.js";
import { normalizeRelativePath } from "./paths.js";

export interface RepositoryDeps {
  knowledgeConfig: {
    sources: ConfiguredKnowledgeRepository[];
    destinations: ConfiguredKnowledgeRepository[];
    flows: ConfiguredKnowledgeFlow[];
    repositories: ConfiguredKnowledgeRepository[];
  };
  knowledgeIndex: InMemoryKnowledgeIndex;
  triggerEmbedding: () => void;
}

export function checkoutRoot(): string {
  return resolveLocalConfiguredPath(process.env.MAGPIE_CHECKOUT_ROOT ?? ".magpie/checkouts");
}

// Where the per-flow snapshot fetch job writes its downloaded gaps/proposals/PR
// data. A sibling of the checkout root by default; override with MAGPIE_SNAPSHOT_ROOT.
export function snapshotRoot(): string {
  return resolveLocalConfiguredPath(process.env.MAGPIE_SNAPSHOT_ROOT ?? ".magpie/snapshots");
}

function resolveLocalConfiguredPath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

// The directory a client-supplied localPath must stay within. Anchored to the
// configured checkout root's parent (the working directory), so a request can
// only ever index something under the deployment's own tree.
function localPathAllowRoot(): string {
  return path.resolve(process.env.MAGPIE_LOCAL_INDEX_ROOT ?? process.env.INIT_CWD ?? process.cwd());
}

// Resolves a client-supplied localPath and rejects any path that escapes the
// allow-root (path traversal). Returns the resolved absolute path on success.
function resolveLocalPathWithinRoot(value: string): string {
  const root = localPathAllowRoot();
  const resolved = resolveLocalConfiguredPath(value);
  const relative = path.relative(root, resolved);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapes) {
    throw new Error("local_path_outside_root");
  }
  return resolved;
}

export async function resolveConfiguredRepositoryLocalPath(
  repository: ConfiguredKnowledgeRepository
): Promise<string> {
  if (repository.kind === "internet" || repository.kind === "agent") {
    throw new Error(`${repository.kind}_sources_cannot_be_checked_out`);
  }

  let localPath: string;
  if (repository.kind === "git") {
    if (!repository.url) {
      throw new Error("configured_git_repository_url_required");
    }
    const checkout = await ensureGitCheckout({
      id: repository.id,
      url: repository.url,
      branch: repository.branch,
      checkoutRoot: checkoutRoot()
    });
    localPath = checkout.localPath;
  } else if (repository.path) {
    localPath = resolveLocalConfiguredPath(repository.path);
  } else {
    throw new Error("configured_local_repository_path_required");
  }

  return repository.subpath ? path.join(localPath, repository.subpath) : localPath;
}

// A stable identity for a configured git checkout (id + url), so the same repo
// configured as both a source and a destination dedupes to one checkout. The NUL
// separator can't appear in either field.
function checkoutKey(repository: ConfiguredKnowledgeRepository): string {
  return `${repository.id}\0${repository.url ?? ""}`;
}

export async function syncConfiguredGitCheckouts(deps: RepositoryDeps): Promise<void> {
  const gitRepositories = uniqueConfiguredGitRepositories([
    ...deps.knowledgeConfig.sources,
    ...deps.knowledgeConfig.destinations
  ]);

  const sourceKeys = new Set(deps.knowledgeConfig.sources.filter((source) => source.kind === "git").map(checkoutKey));

  console.log(`Syncing ${gitRepositories.length} configured git checkout(s)`);
  for (const repository of gitRepositories) {
    const localPath = await resolveConfiguredRepositoryLocalPath(repository);
    if (existsSync(localPath)) {
      console.log(`Synced configured git ${repository.id} at ${localPath}`);
      continue;
    }

    const subpathHint = repository.subpath
      ? ` Configured subpath "${repository.subpath}" was not found in the cloned repository.`
      : "";
    if (sourceKeys.has(checkoutKey(repository))) {
      console.warn(
        `Synced configured git source ${repository.id}, but resolved path ${localPath} does not exist.${subpathHint} ` +
          "Drafts from this source will have no real material until the configuration is corrected."
      );
    } else {
      try {
        await mkdir(localPath, { recursive: true });
        console.log(
          `Created empty destination folder for ${repository.id} at ${localPath}.${subpathHint} ` +
            "This is expected for a fresh destination; it will be populated when proposals are published."
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.warn(`Could not create destination folder for ${repository.id} at ${localPath}: ${message}`);
      }
    }
  }
}

function uniqueConfiguredGitRepositories(
  repositories: ConfiguredKnowledgeRepository[]
): ConfiguredKnowledgeRepository[] {
  const byCheckout = new Map<string, ConfiguredKnowledgeRepository>();

  for (const repository of repositories) {
    if (repository.kind !== "git") {
      continue;
    }

    byCheckout.set(checkoutKey(repository), repository);
  }

  return [...byCheckout.values()];
}

export function defaultDestinationId(deps: RepositoryDeps): string | undefined {
  return deps.knowledgeConfig.destinations.length === 1 ? deps.knowledgeConfig.destinations[0].id : undefined;
}

export function selectFlow(
  deps: RepositoryDeps,
  flowId: string | undefined
): ConfiguredKnowledgeFlow | undefined {
  const trimmed = flowId?.trim();
  if (trimmed) {
    return deps.knowledgeConfig.flows.find((flow) => flow.id === trimmed);
  }

  return deps.knowledgeConfig.flows.length === 1 ? deps.knowledgeConfig.flows[0] : undefined;
}

export function destinationSubpath(deps: RepositoryDeps, destinationId: string | undefined): string | undefined {
  if (!destinationId) {
    return undefined;
  }
  return deps.knowledgeConfig.destinations.find((destination) => destination.id === destinationId)?.subpath;
}

export async function findRepositoryForProposal(
  deps: RepositoryDeps,
  proposal: { targetPath?: string; destinationId?: string }
): Promise<RepositoryRef | undefined> {
  if (deps.knowledgeConfig.destinations.length > 0) {
    const destination = selectDestinationForProposal(deps, proposal);
    if (!destination) {
      return undefined;
    }

    const localPath = await resolveConfiguredRepositoryLocalPath(destination);
    const summary = await deps.knowledgeIndex.indexLocalRepository({
      localPath,
      repositoryId: destination.id,
      name: destination.name
    });
    deps.triggerEmbedding();
    return summary.repository;
  }

  const targetPath = normalizeRelativePath(proposal.targetPath);
  const repositories = deps.knowledgeIndex.listRepositories();
  const explicitMatch = repositories
    .map((repository) => ({
      repository,
      relativePathFromRoot: normalizeRelativePath(repository.git?.relativePathFromRoot)
    }))
    .filter(({ relativePathFromRoot }) => relativePathFromRoot && relativePathFromRoot !== ".")
    .sort((left, right) => right.relativePathFromRoot.length - left.relativePathFromRoot.length)
    .find(
      ({ relativePathFromRoot }) =>
        targetPath === relativePathFromRoot || targetPath.startsWith(`${relativePathFromRoot}/`)
    );

  return (
    explicitMatch?.repository ??
    (repositories.length === 1
      ? repositories[0]
      : repositories.find(
          (repository) => normalizeRelativePath(repository.git?.relativePathFromRoot) === "."
        ))
  );
}

export async function findRepositoryForDestination(
  deps: RepositoryDeps,
  destinationId: string | undefined
): Promise<RepositoryRef | undefined> {
  if (deps.knowledgeConfig.destinations.length > 0) {
    const destination = destinationId
      ? deps.knowledgeConfig.destinations.find((candidate) => candidate.id === destinationId)
      : deps.knowledgeConfig.destinations.length === 1
        ? deps.knowledgeConfig.destinations[0]
        : undefined;
    if (!destination) {
      return undefined;
    }

    const localPath = await resolveConfiguredRepositoryLocalPath(destination);
    const summary = await deps.knowledgeIndex.indexLocalRepository({
      localPath,
      repositoryId: destination.id,
      name: destination.name
    });
    deps.triggerEmbedding();
    return summary.repository;
  }

  const repositories = deps.knowledgeIndex.listRepositories();
  return repositories.length === 1
    ? repositories[0]
    : repositories.find((repository) => normalizeRelativePath(repository.git?.relativePathFromRoot) === ".");
}

export async function resolveIndexSelection(
  deps: RepositoryDeps,
  payload: {
    flowId?: string;
    localPath?: string;
    repositoryId?: string;
    name?: string;
  }
): Promise<{ localPath: string; repositoryId?: string; name?: string }> {
  const indexableDestinations = deps.knowledgeConfig.destinations.filter(
    (destination) => destination.kind === "local" || destination.kind === "git"
  );
  if (indexableDestinations.length > 0) {
    const configured = selectDestinationForIndex(deps, payload, indexableDestinations);
    const localPath = await resolveConfiguredRepositoryLocalPath(configured);
    return { localPath, repositoryId: configured.id, name: configured.name };
  }
  if (deps.knowledgeConfig.destinations.length > 0) {
    throw new Error("configured_repository_not_indexable");
  }
  const selection = resolveKnowledgeRepositorySelection(payload, deps.knowledgeConfig.repositories);
  // Constrain a client-supplied localPath to the allow-root so a crafted
  // "../../etc"-style path can't index files outside the deployment tree.
  return { ...selection, localPath: resolveLocalPathWithinRoot(selection.localPath) };
}

async function indexRepositoryForPayload(
  deps: RepositoryDeps,
  payload: {
    flowId?: string;
    localPath?: string;
    repositoryId?: string;
    name?: string;
  }
): Promise<Awaited<ReturnType<typeof deps.knowledgeIndex.indexLocalRepository>>> {
  const selection = await resolveIndexSelection(deps, payload);
  return deps.knowledgeIndex.indexLocalRepository({
    localPath: selection.localPath,
    repositoryId: selection.repositoryId,
    name: selection.name
  });
}

function selectDestinationForIndex(
  deps: RepositoryDeps,
  payload: { flowId?: string; repositoryId?: string; localPath?: string },
  destinations: ConfiguredKnowledgeRepository[]
): ConfiguredKnowledgeRepository {
  if (payload.localPath?.trim()) {
    throw new Error("localPath is not accepted when knowledge repositories are configured");
  }

  const flowId = payload.flowId?.trim();
  if (flowId) {
    const flow = deps.knowledgeConfig.flows.find((candidate) => candidate.id === flowId);
    const destination = flow ? destinations.find((candidate) => candidate.id === flow.destinationId) : undefined;
    if (!destination) {
      throw new Error("configured_repository_required");
    }
    return destination;
  }

  return resolveConfiguredRepositorySelection(payload, destinations).repository;
}

function configuredIndexPayloads(deps: RepositoryDeps): Array<{ flowId?: string; repositoryId?: string }> {
  if (deps.knowledgeConfig.flows.length > 0) {
    return deps.knowledgeConfig.flows.map((flow) => ({ flowId: flow.id }));
  }

  const indexableDestinations = deps.knowledgeConfig.destinations.filter(
    (destination) => destination.kind === "local" || destination.kind === "git"
  );
  if (indexableDestinations.length > 0) {
    return indexableDestinations.map((destination) => ({ repositoryId: destination.id }));
  }

  return deps.knowledgeConfig.repositories.map((repository) => ({ repositoryId: repository.id }));
}

export async function seedConfiguredKnowledge(
  deps: RepositoryDeps
): Promise<{ indexed: number; failures: Array<{ target: string; message: string }> }> {
  await syncConfiguredGitCheckouts(deps);

  const payloads = configuredIndexPayloads(deps);
  const failures: Array<{ target: string; message: string }> = [];
  let indexed = 0;

  for (const payload of payloads) {
    const target = payload.flowId ?? payload.repositoryId ?? "default";
    try {
      await indexRepositoryForPayload(deps, payload);
      indexed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "index_failed";
      console.warn(`Failed to re-index ${target}: ${message}`);
      failures.push({ target, message });
    }
  }

  deps.triggerEmbedding();
  return { indexed, failures };
}

export function selectDestinationForProposal(
  deps: RepositoryDeps,
  proposal: { targetPath?: string; destinationId?: string }
): ConfiguredKnowledgeRepository | undefined {
  if (proposal.destinationId) {
    return deps.knowledgeConfig.destinations.find((destination) => destination.id === proposal.destinationId);
  }

  const targetPath = normalizeRelativePath(proposal.targetPath);
  const explicitMatch = deps.knowledgeConfig.destinations
    .filter((destination) => destination.subpath)
    .sort((left, right) => (right.subpath ?? "").length - (left.subpath ?? "").length)
    .find((destination) => {
      const subpath = normalizeRelativePath(destination.subpath);
      return targetPath === subpath || targetPath.startsWith(`${subpath}/`);
    });

  return (
    explicitMatch ??
    (deps.knowledgeConfig.destinations.length === 1 ? deps.knowledgeConfig.destinations[0] : undefined)
  );
}
