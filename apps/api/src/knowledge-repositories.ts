import path from "node:path";

export interface ConfiguredKnowledgeRepository {
  id: string;
  name: string;
  path: string;
}

export interface KnowledgeRepositorySelection {
  localPath: string;
  repositoryId?: string;
  name?: string;
}

export function getConfiguredKnowledgeRepositories(
  env: NodeJS.ProcessEnv = process.env
): ConfiguredKnowledgeRepository[] {
  const configured = parseKnowledgeRepositoriesJson(env.KNOWLEDGE_REPOSITORIES);
  if (configured.length > 0) {
    return configured;
  }

  const legacyPath = env.KNOWLEDGE_REPO_PATH?.trim();
  if (!legacyPath) {
    return [];
  }

  const id = slugFromPath(legacyPath);
  return [{ id, name: id, path: legacyPath }];
}

export function resolveKnowledgeRepositorySelection(
  payload: { repositoryId?: string; localPath?: string; name?: string },
  repositories: ConfiguredKnowledgeRepository[]
): KnowledgeRepositorySelection {
  if (repositories.length === 0) {
    const localPath = payload.localPath?.trim();
    if (!localPath) {
      throw new Error("local_path_required");
    }

    return {
      localPath,
      repositoryId: payload.repositoryId?.trim() || undefined,
      name: payload.name?.trim() || undefined
    };
  }

  if (payload.localPath?.trim()) {
    throw new Error("localPath is not accepted when knowledge repositories are configured");
  }

  const repositoryId = payload.repositoryId?.trim();
  const selected =
    (repositoryId ? repositories.find((repository) => repository.id === repositoryId) : undefined) ??
    (repositories.length === 1 ? repositories[0] : undefined);

  if (!selected) {
    throw new Error("configured_repository_required");
  }

  return {
    localPath: selected.path,
    repositoryId: selected.id,
    name: selected.name
  };
}

function parseKnowledgeRepositoriesJson(value: string | undefined): ConfiguredKnowledgeRepository[] {
  if (!value?.trim()) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("KNOWLEDGE_REPOSITORIES must be a JSON array");
  }

  return parsed
    .map((entry) => normalizeRepositoryEntry(entry))
    .filter((entry): entry is ConfiguredKnowledgeRepository => entry !== undefined);
}

function normalizeRepositoryEntry(value: unknown): ConfiguredKnowledgeRepository | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<Record<"id" | "name" | "path", unknown>>;
  const repositoryPath = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!repositoryPath) {
    return undefined;
  }

  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : slugFromPath(repositoryPath);
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id;

  return { id, name, path: repositoryPath };
}

function slugFromPath(value: string): string {
  const basename = path.basename(value.replace(/[\\/]+$/, ""));
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "knowledge-base";
}
