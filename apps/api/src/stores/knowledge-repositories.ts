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
// evaluated per flow; `admin` (config writes and destructive actions like data
// reset or question purge) and `ops` (job and schedule management) are
// deployment-wide capabilities, only ever granted on the "*" flow. See
// docs/authorization.md AZ5 and AZ27.
// Module-local: the capability set is exposed to the rest of the app through the
// KnowledgeCapability type (below), not the array itself.
const KNOWLEDGE_CAPABILITIES = ["read", "manage", "ask", "admin", "ops"] as const;
export type KnowledgeCapability = (typeof KNOWLEDGE_CAPABILITIES)[number];

// role name -> flow id (or "*" for all flows) -> granted capabilities. This is the
// product-owned half of the authorization model: the IdP supplies opaque role names
// on the token, and this map (deployment config, colocated with the flows) says what
// each role may do to which flow. See docs/authorization.md.
export type KnowledgeRoleGrants = Record<string, Record<string, KnowledgeCapability[]>>;

function isKnowledgeCapability(value: string): value is KnowledgeCapability {
  return (KNOWLEDGE_CAPABILITIES as readonly string[]).includes(value);
}

// Capabilities that are deployment-wide: only meaningful on the "*" flow (a
// per-flow grant of one would silently match nothing).
const WILDCARD_ONLY_CAPABILITIES: readonly KnowledgeCapability[] = ["admin", "ops"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses KNOWLEDGE_ROLE_GRANTS STRICTLY. An unset/blank value is the only way to
// get an empty map (flow-scoped authorization inactive, docs/authorization.md
// AZ11); anything else must be a well-formed role -> flow id (or "*") ->
// capabilities map. Every problem is reported in `errors` — unparseable JSON, a
// wrong shape, an unknown capability, or `admin`/`ops` on a specific flow —
// because silently dropping it would FAIL OPEN (a malformed value used to read as
// "no grants", which switches the whole capability layer off). The API refuses to
// boot on any error (loadConfig). Duplicate capabilities are de-duplicated, and a
// role whose every flow lists no capabilities grants nothing.
export function parseRoleGrants(value: string | undefined): { grants: KnowledgeRoleGrants; errors: string[] } {
  const raw = value?.trim();
  if (!raw) {
    return { grants: {}, errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse error";
    return { grants: {}, errors: [`is not valid JSON (${reason})`] };
  }
  if (!isPlainObject(parsed)) {
    return {
      grants: {},
      errors: ['must be a JSON object mapping role name -> flow id (or "*") -> capability array']
    };
  }

  const errors: string[] = [];
  const grants: KnowledgeRoleGrants = {};
  for (const [roleName, perFlow] of Object.entries(parsed)) {
    const role = roleName.trim();
    if (!role) {
      errors.push("has an empty role name");
      continue;
    }
    if (!isPlainObject(perFlow)) {
      errors.push(`role "${role}" must map flow ids (or "*") to capability arrays`);
      continue;
    }

    const normalizedPerFlow: Record<string, KnowledgeCapability[]> = {};
    for (const [flowKey, capabilities] of Object.entries(perFlow)) {
      const flow = flowKey.trim();
      if (!flow) {
        errors.push(`role "${role}" has an empty flow id`);
        continue;
      }
      if (!Array.isArray(capabilities)) {
        errors.push(`role "${role}" flow "${flow}" must be an array of capabilities`);
        continue;
      }
      const granted: KnowledgeCapability[] = [];
      for (const entry of capabilities) {
        const capability = typeof entry === "string" ? entry.trim() : "";
        if (!isKnowledgeCapability(capability)) {
          errors.push(
            `role "${role}" flow "${flow}" has unknown capability ${JSON.stringify(entry)} ` +
              `(expected one of ${KNOWLEDGE_CAPABILITIES.join(", ")})`
          );
          continue;
        }
        if (flow !== "*" && WILDCARD_ONLY_CAPABILITIES.includes(capability)) {
          errors.push(
            `role "${role}" grants "${capability}" on flow "${flow}"; "${capability}" may only be granted on "*"`
          );
          continue;
        }
        granted.push(capability);
      }
      // De-duplicate while preserving the declared order.
      const unique = [...new Set(granted)];
      if (unique.length > 0) {
        normalizedPerFlow[flow] = unique;
      }
    }

    if (Object.keys(normalizedPerFlow).length > 0) {
      grants[role] = normalizedPerFlow;
    }
  }

  return { grants, errors };
}

// The deployment's role grants. Throws on an invalid value rather than returning a
// partial map: loadConfig reports parseRoleGrants' errors first, so this only
// throws for a caller that skipped validation — and then fails closed.
export function getConfiguredRoleGrants(env: EnvLike = process.env): KnowledgeRoleGrants {
  const { grants, errors } = parseRoleGrants(env.KNOWLEDGE_ROLE_GRANTS);
  if (errors.length > 0) {
    throw new Error(`KNOWLEDGE_ROLE_GRANTS ${errors.join("; ")}`);
  }
  return grants;
}

// The env var names each list is read from, in precedence order. The FIRST
// defined one (an explicitly-empty value included, matching `??`) supplies the
// value, so validation reports the variable that actually configured the list.
const SOURCE_ENV_NAMES = ["KNOWLEDGE_SOURCES", "KNOWLEDGE_SOURCE", "SOURCE_DATA", "SOURCE"] as const;
const DESTINATION_ENV_NAMES = ["KNOWLEDGE_DESTINATIONS", "KNOWLEDGE_DESTINATION", "DESTINATION"] as const;
const FLOW_ENV_NAMES = ["KNOWLEDGE_FLOWS", "KNOWLEDGE_FLOW"] as const;
const REPOSITORY_ENV_NAMES = ["KNOWLEDGE_REPOSITORIES"] as const;

function configuredValue(env: EnvLike, names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      return { name, value };
    }
  }
  return undefined;
}

export interface KnowledgeConfigIssue {
  variable: string;
  message: string;
}

// A value that opens with `[` or `{` clearly means to be JSON. The plain-string
// forms (a bare path, git URL, `agent`, `internet`) stay valid; only JSON that
// fails to parse is an error — previously it was silently re-read as a plain
// string, producing a nonsense repository or no flow at all.
function jsonSyntaxIssue(entry: { name: string; value: string } | undefined): KnowledgeConfigIssue | undefined {
  const trimmed = entry?.value.trim();
  if (!entry || !trimmed || !/^[[{]/.test(trimmed)) {
    return undefined;
  }
  try {
    JSON.parse(trimmed);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse error";
    return { variable: entry.name, message: `looks like JSON but does not parse (${reason})` };
  }
}

// Startup validation of the knowledge and authorization config the API reads
// from the environment (docs/configuration.md). Every issue fails boot:
//   - KNOWLEDGE_ROLE_GRANTS that is not a strictly valid grants map (fails open
//     otherwise — see parseRoleGrants);
//   - a sources/destinations/flows/repositories value that is JSON-shaped but
//     unparseable;
//   - a configured flow entry missing its destination or sources, or naming a
//     source/destination id that is not configured (previously such a flow was
//     silently dropped, so asks to it 404ed with no hint why).
export function knowledgeConfigIssues(env: EnvLike = process.env): KnowledgeConfigIssue[] {
  const issues: KnowledgeConfigIssue[] = parseRoleGrants(env.KNOWLEDGE_ROLE_GRANTS).errors.map((message) => ({
    variable: "KNOWLEDGE_ROLE_GRANTS",
    message
  }));

  const flowsEntry = configuredValue(env, FLOW_ENV_NAMES);
  const syntaxIssues = [
    configuredValue(env, REPOSITORY_ENV_NAMES),
    configuredValue(env, SOURCE_ENV_NAMES),
    configuredValue(env, DESTINATION_ENV_NAMES),
    flowsEntry
  ]
    .map(jsonSyntaxIssue)
    .filter((issue): issue is KnowledgeConfigIssue => issue !== undefined);
  issues.push(...syntaxIssues);
  if (syntaxIssues.length > 0 || !flowsEntry?.value.trim()) {
    // Reference checks need parseable lists; an unset flow list is inferred.
    return issues;
  }

  const parsedFlows = parseJsonOrString(flowsEntry.value.trim());
  const entries = Array.isArray(parsedFlows) ? parsedFlows : [parsedFlows];
  const sourceIds = new Set(getConfiguredKnowledgeSources(env).map((source) => source.id));
  const destinationIds = new Set(getConfiguredKnowledgeDestinations(env).map((destination) => destination.id));
  entries.forEach((entry, index) => {
    const flow = normalizeFlowEntry(entry);
    if (!flow) {
      issues.push({
        variable: flowsEntry.name,
        message: `entry ${index} must be an object naming a destinationId and at least one sourceId`
      });
      return;
    }
    const unknownSources = flow.sourceIds.filter((id) => !sourceIds.has(id));
    if (unknownSources.length > 0) {
      issues.push({
        variable: flowsEntry.name,
        message: `flow "${flow.id}" references unknown source id(s) ${unknownSources.map((id) => `"${id}"`).join(", ")}`
      });
    }
    if (!destinationIds.has(flow.destinationId)) {
      issues.push({
        variable: flowsEntry.name,
        message: `flow "${flow.id}" references unknown destination id "${flow.destinationId}"`
      });
    }
  });
  return issues;
}

export function getConfiguredKnowledgeRepositories(env: EnvLike = process.env): ConfiguredKnowledgeRepository[] {
  const configured = parseRepositoryList(configuredValue(env, REPOSITORY_ENV_NAMES)?.value);
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
  const sources = parseRepositoryList(configuredValue(env, SOURCE_ENV_NAMES)?.value);
  return sources.length > 0 ? sources : getConfiguredKnowledgeRepositories(env);
}

export function getConfiguredKnowledgeDestinations(env: EnvLike = process.env): ConfiguredKnowledgeRepository[] {
  const destinations = parseRepositoryList(configuredValue(env, DESTINATION_ENV_NAMES)?.value);
  return destinations.length > 0 ? destinations : getConfiguredKnowledgeRepositories(env);
}

export function getConfiguredKnowledgeFlows(
  env: EnvLike = process.env,
  sources = getConfiguredKnowledgeSources(env),
  destinations = getConfiguredKnowledgeDestinations(env)
): ConfiguredKnowledgeFlow[] {
  const configured = parseFlowList(configuredValue(env, FLOW_ENV_NAMES)?.value);
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
