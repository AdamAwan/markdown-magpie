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
3. **The token is a genuine service / machine-to-machine token** — identified by a
   **positive** signal: the OAuth grant-type claim `gty: "client-credentials"` that
   Auth0 stamps on every client-credentials access token
   (`isClientCredentialsToken`, `packages/auth/src/index.ts`). Auth0's post-login
   Action only runs on interactive logins, so these tokens (the watcher, the MCP
   server) never carry the roles claim; they fall back to scope-only authorization
   rather than being locked out of the callbacks the system depends on.

Only a **role-aware principal** — roles claim *present*, even if `[]` — is held to
the per-flow grants. A role-aware principal with no matching grant is denied
(a `[]`-roles user sees no flow content).

> **Fail closed, not open.** The service carve-out (3) is deliberately a *positive*
> signal, **not** "the roles claim is absent." An earlier design inferred M2M purely
> from a missing roles claim — which meant that if the Auth0 post-login Action was
> removed, disabled, or silently dropped the claim (Auth0 drops non-URL-namespaced
> custom claims), a **human** token would arrive with no roles claim, be
> misclassified as a service principal, and be granted access to **every** flow with
> flow-scoping effectively disabled. Now a token with no roles claim **and** no
> client-credentials marker is **denied** flow-scoped access, and the event is logged
> (`can()` warns: user-facing scopes but no roles claim while grants are configured)
> so the IdP misconfiguration is visible rather than silently failing open.

> **Turning it on.** When you configure `KNOWLEDGE_ROLE_GRANTS`, grant every human
> role its flows, and ensure any service identity keeps working via carve-out (3)
> — i.e. service tokens must be client-credentials tokens (they carry
> `gty: "client-credentials"`). Do not attach roles to M2M tokens.

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

The two watcher-callback endpoints on the answering path enforce the **same `ask`
gate**, so a role-aware user can't reach cross-flow content by calling them directly
instead of `/ask`:

- `POST /api/retrieve` requires `ask` on the requested `flowId`. An **absent
  `flowId`** is the unscoped all-flows search — the flow-less/wildcard case, so only a
  wildcard asker may run it (a single-flow asker must name their flow). Without this,
  the endpoint returned indexed section **content** for any flow, or searched every
  repository unscoped.
- `POST /api/route` is free routing across the caller-supplied candidate flows — the
  same flow-less case as `flow: "auto"`, so it requires a **wildcard** asker.

The watcher itself is unaffected: its M2M token hits carve-out (3), and deployments
with no grants configured behave exactly as before.

### MCP: acting as the end user (on-behalf-of delegation)

The HTTP MCP server verifies the end user's token at its own edge, but calls the
downstream API with its **own M2M service token** — which hits carve-out (3) above
and would bypass flow-scoping. To enforce per-user flow access on the MCP surface,
the server forwards the verified user's identity so the API authorizes as the user.

It does **not** forward the user's token (that token's audience is the MCP
resource, not the API). Instead it uses the **trusted on-behalf-of** pattern
(`packages/auth/src/on-behalf-of.ts`):

- The MCP keeps its M2M token as the transport identity, and adds two headers
  carrying the user it already verified: `x-on-behalf-of-subject` and
  `x-on-behalf-of-roles`.
- The API honors those headers **only** when the authenticated caller holds the
  `act:on-behalf-of` scope — a permission granted *solely* to the MCP's M2M
  application. It then authorizes as the forwarded user (their subject + roles),
  while keeping the caller's scopes as the transport identity
  (`resolveEffectivePrincipal`, applied in `apps/api/src/auth/middleware.ts`).

Trust chain: the API verifies the M2M token + scope → the caller really is the
trusted MCP gateway; that gateway asserts a user identity it independently
verified. A direct user calling the API can't forge this — they don't hold
`act:on-behalf-of`, so their headers are ignored and their own token's roles apply.

> **Setup (one Auth0 permission, no new machinery).** Define an `act:on-behalf-of`
> permission on the API (`AUTH0_AUDIENCE`) and grant it to the MCP's M2M
> application (Applications → APIs → Machine to Machine Applications). That's the
> only IdP change. Keep the MCP→API channel on a trusted network / TLS, since the
> headers are trusted once the caller is authenticated. If the scope is *not*
> granted, MCP calls fall back to the service-identity bypass (carve-out 3) — so,
> like the rest of this model, per-user enforcement on MCP is opt-in.

## Considered and rejected

- **Multi-tenancy** (ownership columns, per-tenant isolation): out of scope; the app
  is single-tenant by design.
- **Per-`sub` config grants**: a maintenance nightmare with staff churn (every
  joiner/leaver is a redeploy editing opaque subject ids).
- **MCP → API via RFC 8693 token exchange** (call the API with an exchanged
  user token): standards-pure, but on Auth0 the only mechanism is **Custom Token
  Exchange** — an Early-Access feature whose profile is Management-API-only (no
  dashboard UI) and which requires a hand-written, self-maintained validation
  Action. That's a lot of IdP machinery for the same result the trusted
  on-behalf-of header achieves with one permission grant, so we chose delegation.
  Reconsider only if a compliance rule forbids trusted-header delegation.
- **Auth0 RBAC `permissions` claim, with the app pushing flows into Auth0 via the
  Management API**: drift-free, but requires a privileged Management-API credential
  in the app and makes the app authoritative for the tenant's scopes — solving a
  drift problem the role-name approach doesn't have (Auth0 never needs to know
  flows). Reconsider only if a compliance requirement mandates that all
  authorization be centralized and auditable in the IdP.
