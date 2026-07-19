import path from "node:path";

type EnvLike = Record<string, string | undefined>;

export interface ConfiguredKnowledgeRepository {
  id: string;
  name: string;
  path?: string;
  url?: string;
  branch?: string;
  subpath?: string;
  kind: "local" | "git" | "internet" | "agent";
  // internet sources only (#242): hostnames the executing agent may fetch over
  // https. Absent/empty means the source stays a prompt-note reference — fetch
  // access is strictly operator opt-in.
  allowedHosts?: string[];
  // git repositories only: the NAME of an environment variable holding a PAT that
  // overrides the host-default token (GITHUB_TOKEN / AZURE_DEVOPS_PAT) for this
  // repository — e.g. a repo held by a different account. Only the name is stored
  // here (never the secret); the process running git resolves the token from its
  // own environment. Absent means "use the host default".
  tokenEnv?: string;
}

export interface ConfiguredKnowledgeFlow {
  id: string;
  name: string;
  sourceIds: string[];
  destinationId: string;
  // Optional admin-authored snippet describing this flow's audience and answering
  // style. Appended to the base answer prompt when this flow answers a question.
  persona?: string;
  // Optional admin-authored summary of WHAT this flow covers (its topical scope),
  // used only to route questions to it via embedding similarity (POST /api/route).
  // Distinct from `persona` (which is answering *voice* and is injected into the
  // answer prompt): a routing summary sharpens routing without changing the answer.
  routingSummary?: string;
  // Coverage mission for seeding/planning prompts — what this KB should cover.
  // Distinct from persona (voice) and routingSummary (router blurb). Consumed by
  // seed planning only; never injected into answer prompts or router flow text.
  charter?: string;
}

export interface KnowledgeRepositorySelection {
  repository: ConfiguredKnowledgeRepository;
}

// Flow-scoped capabilities a role can be granted. `read`/`manage`/`ask` are
// evaluated per flow; `admin` is a deployment-wide capability (gating destructive
// actions like data reset) and is only ever granted on the "*" flow.
// Module-local: the capability set is exposed to the rest of the app through the
// KnowledgeCapability type (below), not the array itself.
const KNOWLEDGE_CAPABILITIES = ["read", "manage", "ask", "admin"] as const;
export type KnowledgeCapability = (typeof KNOWLEDGE_CAPABILITIES)[number];

// role name -> flow id (or "*" for all flows) -> granted capabilities. This is the
// product-owned half of the authorization model: the IdP supplies opaque role names
// on the token, and this map (deployment config, colocated with the flows) says what
// each role may do to which flow. See docs/authorization.md.
export type KnowledgeRoleGrants = Record<string, Record<string, KnowledgeCapability[]>>;

function isKnowledgeCapability(value: string): value is KnowledgeCapability {
  return (KNOWLEDGE_CAPABILITIES as readonly string[]).includes(value);
}

// Parses KNOWLEDGE_ROLE_GRANTS into a normalized grants map. Defensive by design
// (mirrors the flow/repository parsers): malformed entries and unknown capabilities
// are dropped rather than throwing, and an unset/blank value yields an empty map —
// which deliberately leaves flow-scoped authorization INACTIVE (legacy scope-only
// behavior) until an operator opts in by configuring grants.
export function getConfiguredRoleGrants(env: EnvLike = process.env): KnowledgeRoleGrants {
  const raw = env.KNOWLEDGE_ROLE_GRANTS?.trim();
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const grants: KnowledgeRoleGrants = {};
  for (const [roleName, perFlow] of Object.entries(parsed as Record<string, unknown>)) {
    const role = roleName.trim();
    if (!role || !perFlow || typeof perFlow !== "object" || Array.isArray(perFlow)) {
      continue;
    }

    const normalizedPerFlow: Record<string, KnowledgeCapability[]> = {};
    for (const [flowId, capabilities] of Object.entries(perFlow as Record<string, unknown>)) {
      const flow = flowId.trim();
      if (!flow || !Array.isArray(capabilities)) {
        continue;
      }
      const normalized = capabilities
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(isKnowledgeCapability);
      // De-duplicate while preserving the declared order.
      const unique = [...new Set(normalized)];
      if (unique.length > 0) {
        normalizedPerFlow[flow] = unique;
      }
    }

    if (Object.keys(normalizedPerFlow).length > 0) {
      grants[role] = normalizedPerFlow;
    }
  }

  return grants;
}

export function getConfiguredKnowledgeRepositories(env: EnvLike = process.env): ConfiguredKnowledgeRepository[] {
  const configured = parseRepositoryList(env.KNOWLEDGE_REPOSITORIES);
  if (configured.length > 0) {
    return configured;
  }

  const legacyPath = env.KNOWLEDGE_REPO_PATH?.trim();
  if (!legacyPath) {
    return [];
  }

  const id = slugFromPath(legacyPath);
  return [{ id, name: id, path: legacyPath, kind: "local" }];
}

export function getConfiguredKnowledgeSources(env: EnvLike = process.env): ConfiguredKnowledgeRepository[] {
  const sources = parseRepositoryList(env.KNOWLEDGE_SOURCES ?? env.KNOWLEDGE_SOURCE ?? env.SOURCE_DATA ?? env.SOURCE);
  return sources.length > 0 ? sources : getConfiguredKnowledgeRepositories(env);
}

export function getConfiguredKnowledgeDestinations(env: EnvLike = process.env): ConfiguredKnowledgeRepository[] {
  const destinations = parseRepositoryList(env.KNOWLEDGE_DESTINATIONS ?? env.KNOWLEDGE_DESTINATION ?? env.DESTINATION);
  return destinations.length > 0 ? destinations : getConfiguredKnowledgeRepositories(env);
}

export function getConfiguredKnowledgeFlows(
  env: EnvLike = process.env,
  sources = getConfiguredKnowledgeSources(env),
  destinations = getConfiguredKnowledgeDestinations(env)
): ConfiguredKnowledgeFlow[] {
  const configured = parseFlowList(env.KNOWLEDGE_FLOWS ?? env.KNOWLEDGE_FLOW);
  if (configured.length > 0) {
    return configured.filter(
      (flow) =>
        flow.sourceIds.every((sourceId) => sources.some((source) => source.id === sourceId)) &&
        destinations.some((destination) => destination.id === flow.destinationId)
    );
  }

  if (destinations.length === 0) {
    return [];
  }

  const sourceIds = sources.map((source) => source.id);
  return destinations.map((destination) => ({
    id: destination.id,
    name: destination.name,
    sourceIds,
    destinationId: destination.id
  }));
}

export function resolveKnowledgeRepositorySelection(
  payload: { repositoryId?: string; localPath?: string; name?: string },
  repositories: ConfiguredKnowledgeRepository[]
): { localPath: string; repositoryId?: string; name?: string } {
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

  const selection = resolveConfiguredRepositorySelection(payload, repositories).repository;
  if (!selection.path || selection.kind !== "local") {
    throw new Error("configured_repository_requires_checkout");
  }

  return {
    localPath: selection.path,
    repositoryId: selection.id,
    name: selection.name
  };
}

function parseFlowList(value: string | undefined): ConfiguredKnowledgeFlow[] {
  if (!value?.trim()) {
    return [];
  }

  const parsed = parseJsonOrString(value.trim());
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .map((entry) => normalizeFlowEntry(entry))
    .filter((entry): entry is ConfiguredKnowledgeFlow => entry !== undefined);
}

function normalizeFlowEntry(value: unknown): ConfiguredKnowledgeFlow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const destinationId =
    stringValue(candidate.destinationId) ?? stringValue(candidate.destination) ?? stringValue(candidate.kb);
  const rawSourceIds = candidate.sourceIds ?? candidate.sources ?? candidate.source;
  const sourceIds = normalizeIdList(rawSourceIds);
  if (!destinationId || sourceIds.length === 0) {
    return undefined;
  }

  const id = stringValue(candidate.id) ?? `${sourceIds.join("-")}-to-${destinationId}`;
  const persona = stringValue(candidate.persona) ?? stringValue(candidate.description);
  const routingSummary = stringValue(candidate.routingSummary) ?? stringValue(candidate.summary);
  const charter = stringValue(candidate.charter);
  return {
    id,
    name: stringValue(candidate.name) ?? id,
    sourceIds,
    destinationId,
    ...(persona ? { persona } : {}),
    ...(routingSummary ? { routingSummary } : {}),
    ...(charter ? { charter } : {})
  };
}

function normalizeIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter((entry): entry is string => Boolean(entry));
  }

  const single = stringValue(value);
  return single ? [single] : [];
}

export function resolveConfiguredRepositorySelection(
  payload: { repositoryId?: string; localPath?: string },
  repositories: ConfiguredKnowledgeRepository[]
): KnowledgeRepositorySelection {
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

  return { repository: selected };
}

function parseRepositoryList(value: string | undefined): ConfiguredKnowledgeRepository[] {
  if (!value?.trim()) {
    return [];
  }

  const trimmed = value.trim();
  const parsed = parseJsonOrString(trimmed);
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  return entries
    .map((entry) => normalizeRepositoryEntry(entry))
    .filter((entry): entry is ConfiguredKnowledgeRepository => entry !== undefined);
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeRepositoryEntry(value: unknown): ConfiguredKnowledgeRepository | undefined {
  if (typeof value === "string") {
    return normalizeRepositoryObject({ value });
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  return normalizeRepositoryObject(value as Record<string, unknown>);
}

function normalizeRepositoryObject(candidate: Record<string, unknown>): ConfiguredKnowledgeRepository | undefined {
  const rawValue = stringValue(candidate.value);
  const pathCandidate = stringValue(candidate.path) ?? stringValue(candidate.localPath);
  // A file:// value given in the path/localPath field is a LOCAL GIT repo (one we
  // clone and push branches to), not a plain filesystem directory — promote it to
  // `url` so it normalizes to kind "git". (A `file://` in `value` or `url` is already
  // covered below: isGitUrl now matches file://.)
  const pathIsFileUrl = isFileUrl(pathCandidate);
  const url =
    stringValue(candidate.url) ??
    stringValue(candidate.gitUrl) ??
    stringValue(candidate.remoteUrl) ??
    (isGitUrl(rawValue) ? rawValue : undefined) ??
    (pathIsFileUrl ? pathCandidate : undefined);
  const pathValue = pathIsFileUrl ? undefined : (pathCandidate ?? (!isGitUrl(rawValue) ? rawValue : undefined));
  const kind = normalizeKind(candidate.kind, candidate.type, url, pathValue, rawValue);

  if (kind === "agent") {
    const id = stringValue(candidate.id) ?? "agent";
    return {
      id,
      name: stringValue(candidate.name) ?? "Agent Knowledge",
      kind
    };
  }

  if (kind === "internet") {
    const internetUrl = rawValue === "internet" ? undefined : (url ?? rawValue);
    const id = stringValue(candidate.id) ?? (internetUrl ? slugFromPath(internetUrl) : "internet");
    const allowedHosts = normalizeAllowedHosts(candidate.allowedHosts);
    return {
      id,
      name: stringValue(candidate.name) ?? id,
      ...(internetUrl ? { url: internetUrl } : {}),
      ...(allowedHosts ? { allowedHosts } : {}),
      kind
    };
  }

  if (kind === "git") {
    if (!url) {
      return undefined;
    }
    const id = stringValue(candidate.id) ?? slugFromGitUrl(url);
    const repository: ConfiguredKnowledgeRepository = {
      id,
      name: stringValue(candidate.name) ?? id,
      url,
      kind
    };
    const branch = stringValue(candidate.branch);
    const subpath = normalizeSubpath(
      stringValue(candidate.subpath) ?? stringValue(candidate.folder) ?? stringValue(candidate.docsPath)
    );
    // Accept `tokenEnv` (or the `tokenEnvVar` alias) — the NAME of an env var
    // holding a PAT that overrides the host default for this repo.
    const tokenEnv = stringValue(candidate.tokenEnv) ?? stringValue(candidate.tokenEnvVar);
    return {
      ...repository,
      ...(branch ? { branch } : {}),
      ...(subpath ? { subpath } : {}),
      ...(tokenEnv ? { tokenEnv } : {})
    };
  }

  if (!pathValue) {
    return undefined;
  }

  const id = stringValue(candidate.id) ?? slugFromPath(pathValue);
  const subpath = normalizeSubpath(
    stringValue(candidate.subpath) ?? stringValue(candidate.folder) ?? stringValue(candidate.docsPath)
  );
  return {
    id,
    name: stringValue(candidate.name) ?? id,
    path: pathValue,
    ...(subpath ? { subpath } : {}),
    kind: "local"
  };
}

function normalizeKind(
  kind: unknown,
  type: unknown,
  url: string | undefined,
  pathValue: string | undefined,
  rawValue: string | undefined
): ConfiguredKnowledgeRepository["kind"] {
  const value = stringValue(kind) ?? stringValue(type);
  if (value === "internet" || value === "web") {
    return "internet";
  }
  if (value === "agent" || value === "model" || value === "general") {
    return "agent";
  }
  if (rawValue === "agent" || rawValue === "general-agent-knowledge") {
    return "agent";
  }
  if (rawValue === "internet" || rawValue === "web") {
    return "internet";
  }
  if (value === "git" || value === "github" || value === "gitlab" || url) {
    return "git";
  }
  if (pathValue) {
    return "local";
  }
  return "local";
}

function isGitUrl(value: string | undefined): value is string {
  return Boolean(value && (/^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(value) || /\.git(?:#.+)?$/i.test(value)));
}

// A file:// URL — a local git repository we clone and push branches to. Narrower
// than isGitUrl so path/localPath promotion (above) only ever pulls a local-git URL
// out of the path field, never a `.git`-suffixed filesystem path.
function isFileUrl(value: string | undefined): value is string {
  return Boolean(value && /^file:\/\//i.test(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Fetch-allowlist entries are hostnames, compared case-insensitively against the
// hostname of every URL the agent asks to fetch. Defensive like the rest of the
// parser: non-arrays and non-string entries are dropped, hosts are lowercased
// and deduped, and an empty result is treated as "not configured".
function normalizeAllowedHosts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const hosts = [
    ...new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase().replace(/\.$/, "") : ""))
        .filter(Boolean)
    )
  ];
  return hosts.length > 0 ? hosts : undefined;
}

function normalizeSubpath(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized && normalized !== "." ? normalized : undefined;
}

function slugFromGitUrl(value: string): string {
  const withoutHash = value.split("#")[0] ?? value;
  const basename = path.basename(withoutHash.replace(/[\\/]+$/, "").replace(/\.git$/i, ""));
  return slugFromPath(basename);
}

function slugFromPath(value: string): string {
  const basename = path.basename(value.replace(/[\\/]+$/, "").replace(/\.git$/i, ""));
  return (
    basename
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "knowledge-base"
  );
}
