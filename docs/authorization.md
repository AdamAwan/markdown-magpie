# Authorization

Markdown Magpie is a **single-tenant** application: one deployment serves one
organization's shared knowledge base. There is deliberately no tenant/owner model
on proposals, knowledge, or config — see [issue #88](https://github.com/AdamAwan/markdown-magpie/issues/88)
for the decision record.

Within that single deployment, though, the people using it have genuinely
different privileges. This document describes the two-layer authorization model
that expresses them.

## Two layers: global scopes + flow-scoped capabilities

1. **Global scopes** (unchanged) — coarse capabilities carried in the JWT `scope`
   claim and checked by `requireScopes` (`apps/api/src/auth/middleware.ts`):
   `read:knowledge`, `ask:knowledge`, `manage:knowledge`, `manage:jobs`,
   `manage:admin`, `feedback:questions`. These gate *what kind* of action a
   principal may perform. They fail closed (a principal-absent request is denied
   unless auth is explicitly disabled for local dev).

2. **Flow-scoped capabilities** (this feature) — layered *on top of* the scope
   gates to answer *which flow* a principal may act on. The two work together: a
   caller must satisfy the route's scope **and** hold the required capability on
   the resource's flow.

The sensitivity boundary that motivates layer 2: **draft proposals embed
source-derived material**. End users never see source content anywhere else, but a
draft can leak it. So *who may see/administer drafts (and gaps) for which flow* is
a real privilege, not just a global capability.

### Capabilities

| Capability | Scope of grant | Gates |
|---|---|---|
| `read`   | per flow | Reading proposals & gaps for that flow (list results are filtered; single resources in other flows report 404) |
| `manage` | per flow | Drafting, publishing, status changes, reconcile for that flow |
| `ask`    | per flow | Asking questions routed to that flow |
| `admin`  | `*` only | The destructive `POST /admin/reset` (wipes all data) |

## Where grants live: the IdP vs. the product

The binding that **churns** (which humans are on which team) lives in the **IdP**,
because joiner/leaver management is what it's for. The binding that's **stable**
(what a role may do to which flow) lives in **product config**, because it only
changes when flows or teams change — and flows are already product config
(`KNOWLEDGE_FLOWS`), so the IdP never needs to know what a flow is. It only carries
opaque **role names**.

### IdP side: emit role names on the token (Auth0)

Auth0 does not put roles on the access token by default. A `post-login` Action adds
them as a namespaced custom claim:

```js
exports.onExecutePostLogin = async (event, api) => {
  // MUST be a URL-style namespace, or Auth0 silently drops the claim.
  const namespace = "https://magpie.wastedcake.com/";
  const roles = event.authorization?.roles ?? [];
  api.accessToken.setCustomClaim(`${namespace}roles`, roles);
};
```

After deploying the Action **into the Login flow**, a decoded access token carries:

```json
"https://magpie.wastedcake.com/roles": ["kb-hr-curators"]
```

Notes:
- The claim lands on the **access token** (what the API verifies), not the ID token.
- Clients must request a token for the API **audience** (`AUTH0_AUDIENCE`) or the
  custom claim won't be present.
- Joiner/leaver stays entirely in Auth0: assign a role → it appears; disable the
  user → all access evaporates. No product change, no redeploy.

The claim key is configurable via `AUTH_ROLES_CLAIM` (default
`https://magpie.wastedcake.com/roles`, `packages/auth/src/index.ts`).

### Product side: `KNOWLEDGE_ROLE_GRANTS`

A JSON map of **role name → flow id (or `"*"`) → capabilities**, colocated with the
flow config and parsed at startup (`getConfiguredRoleGrants`,
`apps/api/src/stores/knowledge-repositories.ts`):

```jsonc
KNOWLEDGE_ROLE_GRANTS = {
  "kb-hr-curators":  { "hr":  ["read", "manage"] },
  "kb-eng-curators": { "eng": ["read", "manage"] },
  "kb-askers-all":   { "*":   ["ask"] },
  "kb-super":        { "*":   ["read", "manage", "ask", "admin"] }
}
```

Malformed entries and unknown capabilities are dropped defensively.

## Activation and safety carve-outs

Flow-scoping is **opt-in** and cannot break an existing deployment. The capability
check (`principalHasCapability`, `apps/api/src/auth/capabilities.ts`) is permissive
in three cases — it returns "allowed" when:

1. **No grants are configured** (`KNOWLEDGE_ROLE_GRANTS` unset/empty) — the feature
   is inactive and behavior is byte-identical to the scope-only model.
2. **No principal** — auth is disabled (local dev); the scope layer already handled
   it.
3. **The token has no roles claim at all** — a **service / machine-to-machine
   token**. Auth0's post-login Action only runs on interactive logins, so
   client-credentials tokens (the watcher, the MCP server) never carry the claim.
   They fall back to scope-only authorization rather than being locked out of the
   callbacks the system depends on.

Only a **role-aware principal** — roles claim *present*, even if `[]` — is held to
the per-flow grants. A role-aware principal with no matching grant is denied
(a `[]`-roles user sees no flow content).

> **Turning it on.** When you configure `KNOWLEDGE_ROLE_GRANTS`, grant every human
> role its flows, and ensure any service identity keeps working via carve-out (3)
> — i.e. service tokens must remain client-credentials tokens without the roles
> claim. Do not attach roles to M2M tokens.

## Example roles

| Role | Grant | Effect |
|---|---|---|
| End user (MCP `ask`) | `{ "*": ["ask"] }` or `{ "hr": ["ask"] }` | Asks questions; never sees drafts/gaps/sources |
| Knowledge-area owner | `{ "hr": ["read", "manage"] }` | Reads & administers HR proposals/gaps only |
| Ops admin | *(no flow grant; relies on `manage:jobs`/`read:knowledge` scopes)* | Watches jobs/schedules/workers/health; sees **no** draft contents (holds no `read` capability) |
| Super admin | `{ "*": ["read", "manage", "ask", "admin"] }` | Everything, including `/admin/reset` |

Note the ops admin needs no entry in `KNOWLEDGE_ROLE_GRANTS`: their ops routes are
gated by scopes only, while the flow-scoped `read` capability they lack keeps
proposal/gap **contents** closed to them. This is how the previously-overloaded
`read:knowledge` scope is effectively split — the separation emerges from the
capability layer rather than a risky scope rename.

## The `ask` flow and MCP

`POST /ask` requires `ask` on the named flow. `flow: "auto"` (or absent) is treated
as flow-less, so only a **wildcard** asker (`"*": ["ask"]`) can let the watcher
auto-route; a single-flow asker must name their flow.

**Known limitation.** Whether per-user `ask` scoping is enforced for MCP clients
depends on whether the MCP server forwards the end user's token or calls the API
with its own service token. A service token hits carve-out (3) and bypasses
flow-scoping. Enforcing per-user `ask` restrictions *through* MCP is a follow-up
(it requires propagating user identity at the MCP boundary).

## Considered and rejected

- **Multi-tenancy** (ownership columns, per-tenant isolation): out of scope; the app
  is single-tenant by design.
- **Per-`sub` config grants**: a maintenance nightmare with staff churn (every
  joiner/leaver is a redeploy editing opaque subject ids).
- **Auth0 RBAC `permissions` claim, with the app pushing flows into Auth0 via the
  Management API**: drift-free, but requires a privileged Management-API credential
  in the app and makes the app authoritative for the tenant's scopes — solving a
  drift problem the role-name approach doesn't have (Auth0 never needs to know
  flows). Reconsider only if a compliance requirement mandates that all
  authorization be centralized and auditable in the IdP.
