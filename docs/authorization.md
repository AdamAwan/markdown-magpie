# Authorization

> **Status:** living spec (as-built). Source of truth for how Markdown Magpie
> authenticates callers, gates actions by global scope, and layers per-flow
> capabilities on top — including service (machine-to-machine) identity, the
> MCP on-behalf-of delegation path, and the two supported identity providers (Auth0
> and Microsoft Entra ID). Follows the [spec conventions](./README.md#conventions).

## Purpose

Markdown Magpie is a **single-tenant** application: one deployment serves one
organization's shared knowledge base. Within that deployment, people have genuinely
different privileges, and some material (draft proposals embed source-derived content
end users never otherwise see) is more sensitive than the rest. This spec describes
the two-layer authorization model — coarse **global scopes** plus **flow-scoped
capabilities** — that expresses those privileges, where each half of the model is
configured (IdP vs. product), and the trusted delegation the MCP gateway uses to
authorize downstream calls as the real end user.

## Single-tenant boundary

- **AZ1** — There is deliberately **no** tenant/owner model on proposals, knowledge,
  or config; the app MUST NOT introduce ownership columns or per-tenant isolation. All
  authorization is per-principal privilege within one shared deployment. (Decision
  record: [issue #88](https://github.com/AdamAwan/markdown-magpie/issues/88).)

## Two-layer model: global scopes + flow-scoped capabilities

Every protected route is gated by a **global scope**; sensitive per-flow routes are
additionally gated by a **flow-scoped capability**. A caller MUST satisfy both — the
route's scope **and** the required capability on the resource's flow.

- **AZ2** — **Global scopes** are coarse capabilities carried in the JWT `scope` claim
  (Entra: `scp` on user tokens, `roles` on app tokens — see AZ26) and checked by
  `requireScopes` (`apps/api/src/auth/middleware.ts`). They gate *what
  kind* of action a principal may perform. The scopes in use are `read:knowledge`,
  `ask:knowledge`, `manage:knowledge`, `manage:jobs`, `manage:admin`, and
  `feedback:questions`.
- **AZ3** — Scope checks MUST **fail closed**. `requireScopes` denies a
  principal-absent request unless auth was **explicitly** disabled for local dev
  (`c.get("authRequired") === false`); an unset flag is treated as required. Auth
  itself is likewise fail-closed: `isAuthRequired` (`packages/auth/src/index.ts`)
  keeps auth **on** unless an operator sets `AUTH_REQUIRED=false` (case-insensitive) —
  a blank or typo'd value leaves it enabled.
- **AZ4** — **Flow-scoped capabilities** layer on top of the scope gates to answer
  *which flow* a principal may act on. The motivating sensitivity boundary is that
  **draft proposals embed source-derived material**; a draft can leak source content
  that is invisible everywhere else, so *who may see/administer drafts (and gaps) for
  which flow* is a real privilege, not just a global capability.
- **AZ5** — The capability set is exactly `read`, `manage`, `ask`, `admin`, `ops`
  (`KNOWLEDGE_CAPABILITIES`, `apps/api/src/stores/knowledge-repositories.ts`).
  `read`/`manage`/`ask` are evaluated **per flow**; `admin` and `ops` are
  deployment-wide and MUST only ever be granted on the wildcard `*` flow (a per-flow
  grant of either matches nothing).

| Capability | Scope of grant | Gates |
|---|---|---|
| `read`   | per flow | Reading proposals & gaps for that flow (list results are filtered; single resources in other flows report 404) |
| `manage` | per flow | Drafting, publishing, status changes, reconcile for that flow |
| `ask`    | per flow | Asking questions routed to that flow |
| `admin`  | `*` only | The destructive `POST /api/admin/reset` (wipes all data); on Entra also config writes and question purge (AZ27) |
| `ops`    | `*` only | On Entra only: job and schedule management and maintenance triggers (AZ27) |

## Where grants live: the IdP vs. the product

The binding that **churns** (which humans are on which team) lives in the **IdP**,
because joiner/leaver management is what it's for. The binding that's **stable** (what
a role may do to which flow) lives in **product config**, because it only changes when
flows or teams change — and flows are already product config (`KNOWLEDGE_FLOWS`), so
the IdP never needs to know what a flow is. It only carries opaque **role names**.

- **AZ6** — The IdP MUST emit the principal's role names as a **namespaced custom
  claim** on the **access token** (what the API verifies), not the ID token. On Auth0
  this is done by a `post-login` Action; the claim key MUST be a URL-style namespace or
  Auth0 silently drops it.

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

- **AZ7** — Clients MUST request a token for the API **audience** (`AUTH_AUDIENCE`,
  legacy `AUTH0_AUDIENCE`)
  or the custom claim is absent. Joiner/leaver management stays entirely in the IdP:
  assigning a role makes it appear and disabling a user evaporates all access, with no
  product change or redeploy.
- **AZ8** — The verifier reads role names via `rolesFromPayload` from the claim key
  `rolesClaim`, configurable through `AUTH_ROLES_CLAIM` and defaulting per provider:
  Auth0 `DEFAULT_ROLES_CLAIM` = `https://magpie.wastedcake.com/roles`, Entra `roles`
  (`packages/auth/src/provider.ts`). String entries only; anything non-string is dropped.
- **AZ9** — A **present** roles claim (even the empty array `[]`) makes a principal
  **role-aware**; an **absent** claim leaves `Principal.roles` `undefined`. This
  distinction is load-bearing (see AZ13–AZ15): a present claim fully determines flow
  access from those roles, whereas an absent claim is **not** on its own sufficient to
  grant any bypass.
- **AZ10** — The product half is `KNOWLEDGE_ROLE_GRANTS`: a JSON map of **role name →
  flow id (or `"*"`) → capabilities**, colocated with the flow config and parsed at
  startup by `parseRoleGrants` (`apps/api/src/stores/knowledge-repositories.ts`).
  Parsing MUST be **strict**: only an unset/blank value yields an empty map (feature
  inactive, see AZ11); unparseable JSON, a non-object, a role or flow entry of the
  wrong shape, an unknown or non-string capability, or `admin`/`ops` granted on a
  specific flow is a startup error naming `KNOWLEDGE_ROLE_GRANTS`
  (`knowledgeConfigIssues`, reported by `loadConfig`). Duplicate capabilities are
  de-duplicated. (Before this, malformed values were silently dropped — and a value
  that failed to parse read as "no grants", switching flow-scoping **off**: a typo
  failed authorization open.)

```jsonc
KNOWLEDGE_ROLE_GRANTS = {
  "kb-hr-curators":  { "hr":  ["read", "manage"] },
  "kb-eng-curators": { "eng": ["read", "manage"] },
  "kb-askers-all":   { "*":   ["ask"] },
  "kb-super":        { "*":   ["read", "manage", "ask", "admin", "ops"] }
}
```

## Activation and safety carve-outs

Flow-scoping is **opt-in** and cannot break an existing deployment. The capability
check `principalHasCapability` (`apps/api/src/auth/capabilities.ts`) returns "allowed"
in three deliberately-permissive cases.

- **AZ11** — **No grants configured** (`KNOWLEDGE_ROLE_GRANTS` unset/empty): the
  feature is inactive and behaviour MUST be byte-identical to the scope-only model.
  This carve-out exists only for providers with per-user scopes: on Entra the API
  refuses to boot without grants (AZ28) and the privileged gate has no such carve-out
  (AZ27).
- **AZ12** — **No principal**: auth is disabled (local dev) and the scope layer
  already handled the request.
- **AZ13** — **A genuine service / machine-to-machine token**, identified by a
  **positive** signal computed once at verify time as `Principal.isService`
  (`packages/auth/src/provider.ts`): on Auth0 the OAuth grant-type claim
  `gty: "client-credentials"` stamped on every client-credentials access token
  (`isClientCredentialsToken`); on Entra the `idtyp: "app"` optional claim (AZ26).
  These tokens (the watcher, the MCP server) never carry user roles — Auth0's
  post-login Action only runs on interactive logins, and an Entra app token's `roles`
  are application permissions, mapped to scopes — so they fall back to scope-only
  authorization rather than being locked out of the callbacks the system depends on.
- **AZ14** — Only a **role-aware** principal (roles claim present, even if `[]`) is
  held to the per-flow grants. A role-aware principal with no matching grant MUST be
  **denied** (a `[]`-roles user sees no flow content). A grant matches when one of the
  principal's roles has the capability on the resource's `flowId`, or on `*` (the
  wildcard, which also is the only way to match a **flow-less** resource); multiple
  roles union their grants, and unknown roles are ignored.
- **AZ15** — The service carve-out (AZ13) MUST be a **positive** signal, **not** "the
  roles claim is absent." A token with **no roles claim and no service marker**
  (`isService` false) is a human token whose claim went missing (e.g. the Auth0 Action was
  removed, disabled, or dropped a non-URL-namespaced claim) and MUST be **denied**
  flow-scoped access — never reclassified as an all-flows service principal, which
  would fail flow-scoping **open**. The event SHOULD be surfaced: `can()` logs a
  warning via `isRolelessHumanToken` — true when grants are configured and the
  principal has **no roles claim and is not a service** — so the IdP
  misconfiguration is visible rather than silent. (Such a token necessarily already
  cleared the route's scope gate, hence the warning message's "user-facing scopes"
  framing; the predicate itself tests grants + absent-roles + not-service, not
  scopes.)

> **Fail closed, not open.** An earlier design inferred M2M purely from a missing
> roles claim; if the post-login Action was removed or silently dropped the claim, a
> **human** token would arrive with no roles claim, be misclassified as a service
> principal, and be granted access to **every** flow with flow-scoping effectively
> disabled. AZ15 replaces that with the positive service marker.

> **Turning it on.** When you configure `KNOWLEDGE_ROLE_GRANTS`, grant every human
> role its flows, and ensure any service identity keeps working via carve-out AZ13 —
> i.e. service tokens must be client-credentials tokens (Auth0
> `gty: "client-credentials"`; Entra `idtyp: "app"`). Do **not** attach roles to
> Auth0 M2M tokens.

- **AZ16** — Enforcement is exposed to routes as `can(ctx, c, capability, flowId)`
  (boolean) and `assertCan(...)` (throws **403 `forbidden`**), matching
  `requireScopes`' shape (`apps/api/src/auth/capabilities.ts`).

### Example roles

| Role | Grant | Effect |
|---|---|---|
| End user (MCP `ask`) | `{ "*": ["ask"] }` or `{ "hr": ["ask"] }` | Asks questions; never sees drafts/gaps/sources |
| Knowledge-area owner | `{ "hr": ["read", "manage"] }` | Reads & administers HR proposals/gaps only |
| Ops admin | Auth0: *(no flow grant; relies on `manage:jobs`/`read:knowledge` scopes)*. Entra: `{ "*": ["ops"] }` (AZ27) | Watches and manages jobs/schedules/workers/health; sees **no** draft contents (holds no `read` capability) |
| Super admin | `{ "*": ["read", "manage", "ask", "admin", "ops"] }` | Everything, including `/api/admin/reset` |

- **AZ17** — On Auth0, an ops admin needs **no** entry in `KNOWLEDGE_ROLE_GRANTS`:
  their ops routes are gated by scopes only (on Entra they need `ops` on `*`, AZ27), while the flow-scoped `read` capability they lack
  keeps proposal/gap **contents** closed to them. This is how the previously-overloaded
  `read:knowledge` scope is effectively split — the separation emerges from the
  capability layer rather than a risky scope rename.

## The `ask` flow, watcher callbacks, and MCP

- **AZ18** — `POST /api/ask` requires the `ask` capability on the **named** flow
  (`assertCan(ctx, c, "ask", requestedFlow)`). `flow: "auto"` (or absent) is treated as
  flow-less, so only a **wildcard** asker (`"*": ["ask"]`) can let the watcher
  auto-route; a single-flow asker MUST name their flow.
- **AZ19** — The two watcher-callback endpoints on the answering path MUST enforce the
  **same `ask` gate**, so a role-aware user cannot reach cross-flow content by calling
  them directly instead of `/api/ask`:
  - `POST /api/retrieve` requires `ask` on the requested `flowId`
    (`assertCan(ctx, c, "ask", flowId)`). An **absent `flowId`** is the unscoped
    all-flows search — the flow-less/wildcard case — so only a wildcard asker (or a
    genuine service principal) may run it.
  - `POST /api/route` is free routing across the caller-supplied candidate flows — the
    same flow-less case as `flow: "auto"` — so it requires a **wildcard** asker
    (`assertCan(ctx, c, "ask", undefined)`).
- **AZ20** — The watcher itself is unaffected: its M2M token hits carve-out AZ13, and
  deployments with no grants configured behave exactly as before.

### Service-token acquisition (machine-to-machine callers)

- **AZ21** — Backend services that call the API with their **own** M2M credential (the
  watcher, the HTTP MCP gateway) MUST acquire the token at runtime via the OAuth
  **client-credentials** grant and cache it until shortly before expiry, refreshing
  transparently (`createApiTokenProvider`, `packages/auth/src/api-token.ts`). A static
  token is supported only as a legacy fallback; because Auth0 access tokens expire
  (default 24h), a pasted static token silently breaks every call a day after deploy.
  Runtime acquisition is enabled only when all of `clientId`, `clientSecret`,
  `tokenUrl`, and `audience` are supplied (plus `apiIdUri` on Entra); concurrent
  refreshes are collapsed into one fetch, and the token is refreshed
  `EXPIRY_SKEW_SECONDS = 60` before its stated expiry. The token endpoint is
  `AUTH_TOKEN_URL`, defaulting per provider (AZ25), and the request shape is
  provider-specific: Auth0 gets a JSON body naming the API `audience`; Entra gets a
  form-encoded body requesting the `${AUTH_API_ID_URI}/.default` scope.

### MCP: acting as the end user (on-behalf-of delegation)

The HTTP MCP server verifies the end user's token at its own edge but calls the
downstream API with its **own** M2M service token — which hits carve-out AZ13 and would
bypass flow-scoping. To enforce per-user flow access on the MCP surface, the server
forwards the verified user's identity so the API authorizes as the user. It does
**not** forward the user's token (that token's audience is the MCP resource, not the
API); it uses the **trusted on-behalf-of** pattern (`packages/auth/src/on-behalf-of.ts`).

- **AZ22** — The MCP keeps its M2M token as the transport identity and adds two headers
  carrying the user it already verified: `x-on-behalf-of-subject`
  (`ON_BEHALF_OF_SUBJECT_HEADER`) and `x-on-behalf-of-roles`
  (`ON_BEHALF_OF_ROLES_HEADER`). The roles header is JSON-serialized
  (`serializeOnBehalfRoles`), never space-delimited, so a role name is never ambiguous.
- **AZ23** — The API MUST honor those headers **only** when the authenticated caller
  holds the `act:on-behalf-of` scope (`ON_BEHALF_OF_SCOPE`) — a permission granted
  *solely* to the MCP's M2M application. `resolveEffectivePrincipal` (applied in
  `apps/api/src/auth/middleware.ts`) then authorizes as the forwarded user (their
  subject + roles) while keeping the **caller's scopes** as the transport identity. The
  **presence** of a parseable roles header is what activates delegation for a request;
  an absent or malformed roles header means "no delegation, use my own identity."
- **AZ24** — An empty forwarded roles list `[]` MUST fail closed: the effective
  principal is role-aware with no flow access, exactly like AZ14. A direct user cannot
  forge delegation — they do not hold `act:on-behalf-of`, so their headers are ignored
  and their own token's roles apply.

Trust chain: the API verifies the M2M token + scope → the caller really is the trusted
MCP gateway; that gateway asserts a user identity it independently verified. This is
the "trusted subsystem" / BFF pattern — no IdP token-exchange machinery, and the API
stays the single source of authorization truth.

> **Setup (one IdP permission, no new machinery).** Define an `act:on-behalf-of`
> permission on the API (`AUTH_AUDIENCE`; on Entra, an application-type app role — see
> AZ26) and grant it to the MCP's M2M application
> (Applications → APIs → Machine to Machine Applications). That is the only IdP change.
> Keep the MCP→API channel on a trusted network / TLS, since the headers are trusted
> once the caller is authenticated. If the scope is *not* granted, MCP calls fall back
> to the service-identity bypass (AZ13) — so, like the rest of this model, per-user
> enforcement on MCP is opt-in.

## Identity providers

The verifier, the startup checks, and the service-token client are provider-neutral;
everything that differs between providers is computed in one profile per provider in
`packages/auth/src/provider.ts`, so the apps never branch on the provider.

- **AZ25** — `AUTH_PROVIDER` selects `auth0` (default) or `entra`; any other value is a
  startup error (`authEnvIssues`, checked by the API and watcher config loaders). The
  generic env names win over the legacy Auth0 names, which remain as fallbacks so an
  existing Auth0 deployment needs **no** env changes (`authSettingsFromEnv`,
  `packages/auth/src/index.ts`):

  | Var | Legacy fallback | auth0 default | entra default |
  | --- | --- | --- | --- |
  | `AUTH_ISSUER` | `AUTH0_ISSUER_BASE_URL`, then `https://${AUTH0_DOMAIN}` | — (normalised to one trailing slash) | — (used **verbatim**, e.g. `https://login.microsoftonline.com/<tenant-id>/v2.0`) |
  | `AUTH_AUDIENCE` | `AUTH0_AUDIENCE` | — | — (the API app's client-ID GUID) |
  | `AUTH_JWKS_URI` | `AUTH0_JWKS_URI` | `<issuer>.well-known/jwks.json` | `<authority>/discovery/v2.0/keys` |
  | `AUTH_TOKEN_URL` | — | `<issuer>oauth/token` | `<authority>/oauth2/v2.0/token` |
  | `AUTH_API_ID_URI` | — | unused | `api://<AUTH_AUDIENCE>` |
  | `AUTH_ROLES_CLAIM` | — | `https://magpie.wastedcake.com/roles` | `roles` |

  (`<authority>` is the Entra issuer with its trailing `/v2.0` removed.) When auth is
  required, the API and watcher refuse to start without an audience (new **or** legacy
  name, never the `.env.example` placeholder) and an issuer.
- **AZ26** — Claim mapping. The verifier returns the same `Principal` for both
  providers:

  | | auth0 | entra |
  | --- | --- | --- |
  | `subject` | `sub` | `oid` (fallback `sub`) — Entra's `sub` is pairwise per app |
  | `scopes` (user token) | `scope`, space-split | `scp`, space-split |
  | `scopes` (service token) | `scope` | the `roles` array (application permissions) |
  | `roles` (user token) | `rolesClaim` | `rolesClaim` (`roles`: the user's app-role assignments) |
  | `roles` (service token) | `rolesClaim` (normally absent) | always `undefined` — app-token `roles` are permissions, **never** user roles |
  | `isService` | `gty === "client-credentials"` | `idtyp === "app"` |

  An Entra app token **without** the `idtyp` optional claim is not recognised as a
  service and gets no scopes (it has no `scp`), so it fails closed with 403s.

### Privileged actions when scopes are not per-user

- **AZ27** — Auth0 RBAC issues each user only the scopes their roles carry, so a scope
  gate is a per-user check. Entra grants every consented delegated scope to **every**
  user who can sign in (the console requests all of them, including `manage:admin`), so
  on Entra a user token's `scp` says nothing about the user. Each provider profile
  declares this as `perUserScopes` (`packages/auth/src/provider.ts`: auth0 `true`, entra
  `false`). Where it is `false`, the privileged routes below MUST authorize a **human**
  principal from its app **roles**: the route's scope gate still applies, and
  `requirePrivilege(ctx, capability)` (`apps/api/src/auth/capabilities.ts`) additionally
  requires one of the principal's roles to hold the capability on `*` in
  `KNOWLEDGE_ROLE_GRANTS`. A roleless human (an Entra user with no app-role assignment
  carries no `roles` claim) is denied, and there is **no** "no grants configured"
  carve-out (AZ11 does not apply here). Denials are 403 `forbidden` and logged.

  | Capability | Routes |
  | --- | --- |
  | `admin` | `POST /api/config`, `POST /api/admin/reset` (which also keeps its AZ16 `assertCan(admin)`), `DELETE /api/questions/:id` |
  | `ops` | `POST /api/jobs`, `POST /api/jobs/:id/{cancel,retry,accept-failure}`, `POST /api/scheduled-tasks/:key/{settings,run}`, `POST /api/fix-patrol/run`, `POST /api/fix-patrol/improve/run`, `POST /api/source-sync/run`, `POST /api/flows/:flowId/seed-bootstrap/run` |

  Unchanged by AZ27: requests with **no principal** (auth disabled), **service**
  principals (`isService` — their scopes are per-application permissions an
  administrator consented to, so the watcher's orchestration calls keep working), and
  every route on a provider whose scopes are per-user (Auth0 stays scope-only, exactly
  as before). An MCP-delegated request (AZ23) is not a service principal, so on Entra it
  is held to the forwarded user's roles.
- **AZ28** — Because AZ27 makes role grants the only per-user authorization on such a
  provider, the API MUST refuse to boot when `AUTH_PROVIDER=entra`, auth is enabled,
  and `KNOWLEDGE_ROLE_GRANTS` is unset or empty (`authorizationConfigIssues`,
  `apps/api/src/platform/config.ts`), naming `KNOWLEDGE_ROLE_GRANTS` in the startup
  error. Previously such a deployment made every signed-in employee effectively an
  admin. A minimal Entra grant set is
  `{"magpie-admins": {"*": ["read", "manage", "ask", "admin", "ops"]}}`, plus per-flow
  roles for everyone else (AZ14: a user whose roles match no grant sees no flow
  content).

> ⚠️ **Residual (Entra).** The flow-scoped `manage` capability (AZ14) already gates
> per-flow writes, and the routes above are role-gated, but scope-only routes outside
> that list still trust Entra's non-per-user scopes: `GET /api/config` (masked runtime
> config, read by every console poll), `POST /api/knowledge/repositories/index`
> (re-index), and `POST /api/proposals/:id/verify-closure` (a maintenance callback).

### Using Microsoft Entra ID

Single-tenant only: the issuer is validated exactly, so tokens from any other tenant
(and v1 tokens, whose `iss` is `https://sts.windows.net/<tenant-id>/`) are rejected.

**App registrations**

1. **API app** (the resource the API, watcher and MCP validate against):
   - In the manifest set `"requestedAccessTokenVersion": 2` (v2 tokens: `aud` = the
     client-ID GUID, `iss` = `https://login.microsoftonline.com/<tenant-id>/v2.0`).
   - **Expose an API** → set the Application ID URI (default `api://<client-id>`; if you
     choose another, set `AUTH_API_ID_URI`) and add **delegated scopes** named after
     the global scopes (`read:knowledge`, `ask:knowledge`, `manage:knowledge`,
     `manage:jobs`, `manage:admin`, `feedback:questions`).
   - **App roles**: add *Users/Groups* roles for the role names your
     `KNOWLEDGE_ROLE_GRANTS` uses (e.g. `kb-hr-curators`) and assign users/groups to
     them under Enterprise applications; add *Applications* roles for the service
     permissions (`read:knowledge`, `ask:knowledge`, `manage:knowledge`,
     `manage:jobs`, and `act:on-behalf-of` for MCP).
   - **Token configuration** → add the `idtyp` optional claim to the **access** token.
     Without it no service token is recognised (AZ26).
2. **Watcher M2M app**: a client secret, plus **application permissions** on the API
   app for `manage:jobs`, `ask:knowledge`, `read:knowledge`, `manage:knowledge` —
   admin-consented.
3. **MCP M2M app**: as above for the scopes its tools use, plus `act:on-behalf-of`
   (AZ23).
4. **Web SPA app**: see the web console's settings in `.env.example` (`AUTH_CLIENT_ID`,
   `AUTH_REDIRECT_URI`, `NEXT_PUBLIC_AUTH_*`).

**Server env**

```bash
AUTH_PROVIDER=entra
AUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
AUTH_AUDIENCE=<api-app-client-id>
# AUTH_API_ID_URI=api://<api-app-client-id>   # only if you changed the Application ID URI
WATCHER_API_CLIENT_ID=<watcher-app-client-id>
WATCHER_API_CLIENT_SECRET=<secret>
MCP_API_CLIENT_ID=<mcp-app-client-id>
MCP_API_CLIENT_SECRET=<secret>
```

JWKS and token endpoints, the roles claim, and the client-credentials scope
(`<AUTH_API_ID_URI>/.default`) are derived automatically (AZ25).

**Known caveats**

- **Scope / app-role values.** The product's names use `verb:noun` (with a colon).
  Whether the Entra portal and Graph accept a colon in delegated-scope and app-role
  `value`s is **not yet verified** against a live tenant; if they are rejected, Entra
  support needs a name-mapping layer before it can be used.
- **Delegated scopes are not per-user.** Auth0 RBAC can restrict which scopes a user
  receives; Entra grants every consented delegated scope the client requests to every
  user who can sign in. The API therefore authorizes privileged actions from app roles
  on Entra (AZ27) and refuses to boot without `KNOWLEDGE_ROLE_GRANTS` (AZ28). Also gate
  who can sign in (*Assignment required* on the enterprise app).
- **Multi-tenant is not supported** (single issuer, validated exactly).
- **Switching an existing deployment changes subjects.** Entra subjects are `oid`s,
  not Auth0 `sub`s, so everything keyed on the subject (per-principal rate-limit
  buckets, the subject in logs and on-behalf-of headers) refers to new identities,
  and role assignments must be recreated as Entra app-role assignments.
- **MCP client sign-in** needs its own Entra app registration (Application ID URI =
  the MCP URL, delegated scopes for the tools) and `MCP_AUDIENCE` set to that app's
  client-ID GUID; the protected-resource metadata then advertises the versioned
  `.../oauth21/2026-08` authorization server (CIMD clients need no pre-registration)
  and fully qualified scopes. See [mcp.md](./mcp.md#entra-id-mcp-client-sign-in). The
  MCP's downstream service token follows `AUTH_PROVIDER` as above.

## Considered and rejected

- **Multi-tenancy** (ownership columns, per-tenant isolation): out of scope; the app
  is single-tenant by design (AZ1).
- **Per-`sub` config grants**: a maintenance nightmare with staff churn (every
  joiner/leaver is a redeploy editing opaque subject ids).
- **MCP → API via RFC 8693 token exchange** (call the API with an exchanged user
  token): standards-pure, but on Auth0 the only mechanism is **Custom Token Exchange**
  — an Early-Access feature whose profile is Management-API-only (no dashboard UI) and
  which requires a hand-written, self-maintained validation Action. That is a lot of
  IdP machinery for the same result the trusted on-behalf-of header achieves with one
  permission grant, so we chose delegation. Reconsider only if a compliance rule
  forbids trusted-header delegation.
- **Auth0 RBAC `permissions` claim, with the app pushing flows into Auth0 via the
  Management API**: drift-free, but requires a privileged Management-API credential in
  the app and makes the app authoritative for the tenant's scopes — solving a drift
  problem the role-name approach does not have (Auth0 never needs to know flows).
  Reconsider only if a compliance requirement mandates that all authorization be
  centralized and auditable in the IdP.

## Code map

| Concern | Code |
| --- | --- |
| Token verification, env resolution (`authSettingsFromEnv`, `authEnvIssues`) | `packages/auth/src/index.ts` |
| Per-provider profiles: issuer/JWKS/token URL defaults, claim mapping, `isService`, client-credentials request shape, MCP advertisement (authorization server, scope form, Entra resource checks) | `packages/auth/src/provider.ts` |
| Runtime M2M service-token acquisition (client-credentials) | `packages/auth/src/api-token.ts` |
| On-behalf-of delegation (headers, scope, resolver) | `packages/auth/src/on-behalf-of.ts` |
| `requireAuth` / `requireScopes` + delegation wiring | `apps/api/src/auth/middleware.ts` |
| Flow-scoped check, `can` / `assertCan`, roleless-human alert, privileged-action gate (`requirePrivilege`) | `apps/api/src/auth/capabilities.ts` |
| Entra boot check (no role grants with auth on) | `apps/api/src/platform/config.ts` (`authorizationConfigIssues`) |
| Capability set, `KNOWLEDGE_ROLE_GRANTS` parsing | `apps/api/src/stores/knowledge-repositories.ts` (`getConfiguredRoleGrants`) |
| Enforcement points (`assertCan`) | `apps/api/src/features/{ask,retrieve,route}/routes.ts`, `apps/api/src/features/config/routes.ts` (`/admin/reset`) |
| Enforcement points (`requirePrivilege`, AZ27) | `apps/api/src/features/{config,jobs,questions,scheduled-tasks,patrol,source-sync,seed}/routes.ts` |

## Tests (behavioural contract)

`packages/auth/src/{index,api-token,on-behalf-of}.test.ts` (incl. Entra issuer,
endpoint defaults, claim mapping, form-encoded client-credentials, legacy-env
fallbacks), `apps/api/src/platform/config.test.ts`, `apps/watcher/src/config.test.ts`,
`apps/api/src/auth/{capabilities,middleware,middleware.delegation,privileged-routes}.test.ts`,
`apps/api/src/features/{retrieve,route}/routes.flow-scope.test.ts`.

## Provenance (design history)

Builds on `docs/superpowers/specs/2026-06-18-auth0-mcp-gating-design.md` (the Auth0
gating foundation — token verification, the three gated surfaces, local-dev opt-out)
and `2026-07-01-watcher-startup-config-validation-design.md` (the M2M
client-credentials vs. legacy static `API_TOKEN` credential rules behind AZ21). The
single-tenant decision (AZ1) is recorded in
[issue #88](https://github.com/AdamAwan/markdown-magpie/issues/88). The flow-scoped
capability layer, the fail-closed service carve-out (AZ13/AZ15), and the on-behalf-of
delegation path are as-built here and have no separate elevated design doc in the
archive — this spec is their source of truth.
