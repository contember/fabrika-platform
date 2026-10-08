# Secure-by-default application runtime

A proposal to make Fabrika applications opinionated before production applications are built on them.
The goal is narrow: **minimize the chance that a coding agent, steered by an inexperienced person,
ships an application that grants unauthorized access.** Everything below is judged against that goal.

The proposal is the core of a set:

- [Scoped database access](scoped-database-access.md) — row-level enforcement in the data layer.
- [Application file storage](app-file-storage.md) — files that inherit their parent object's access.
- [Scheduled jobs](app-scheduled-jobs.md) — cron work with a declared, narrow identity.
- [Declarative application connectors](declarative-app-connectors.md) — read-only data exchange between
  apps.

## Threat model

The person driving the agent does not read the diff. They describe a feature, the agent writes it, and
they deploy when it "works". The agent is competent but optimizes for "works": when a request is
refused, it loosens whatever refused it, and it edits any file to get there — the contract, table
policies, `zerops.yaml`, build commands, lint configuration, type assertions.

Catastrophic outcomes, in order of likelihood:

1. **An endpoint with no authorization**, or one whose check was removed to fix a 403.
2. **Authenticated mistaken for authorized.** IAM mints a token for every app for every human who can
   sign in, with whatever permissions resolve — possibly none (`mintToken` in
   `packages/iam/src/tokens.ts`). With an open identity-provider domain, "signed in" means "anyone on the
   internet with an account".
3. **Object-level access (IDOR).** The endpoint checks `notes.read`, but loads any note by id or lists
   every workspace — or holds the right object for the wrong operation.
4. **Trusting client-supplied identity or scope** (`ownerId`, `workspaceId` from the request body).
5. **Leaked fields** — a whole database row returned.
6. **A widened front door or role** — an anonymous endpoint, or an action added to a role everyone holds,
   in the contract or directly in IAM.
7. **Provider-level exposure** — a public bucket, a direct binding to another application's resources,
   the shared database credential.

In agent-built applications broken access control is the leading vulnerability class, ahead of
injection ([arXiv 2606.23130](https://arxiv.org/abs/2606.23130): 28.6 % vs 16.8 %). The OWASP
[API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) ranks broken
object-level authorization first.

**Assumptions:** the agent's machine holds no provider token (zcli, Cloudflare API) and no IAM
administrator session, and the agent cannot complete a WebAuthn user-verification prompt on the approver's
device. If any of these fails, every layer below is optional for the agent.

## Principles

- **One declaration, many enforcers.** The application's access surface is one pure-data contract plus
  its table policies. The proxy, IAM, Control and the provider each enforce their part. Nothing is
  written twice.
- **Hard guarantees live outside the application process.** The proxy, IAM, Control and the provider
  enforce what was approved, read from the commit being deployed — never a description the running
  application reports about itself.
- **In-process protections are best-effort against a deliberate bypass — and the types are best-effort even
  without one.** TypeScript checks method parameters bivariantly, so code can widen a `Ref` without any cast
  (shown by a spike); the runtime checks in the data layer are required, not a fallback. Types, `Ref`s and the scoped
  data layer stop the agent's honest mistakes and make bypasses conspicuous. They cannot stop code that
  runs in the same process with the same credentials from going around them. Database row-level
  security (see [scoped database access](scoped-database-access.md)) is the second layer; a platform data
  executor is the long-term hard boundary.
- **Nothing is open by omission.** A missing access declaration is a type error, a build error, and a
  path the proxy denies.
- **Authenticated is never enough.** Every endpoint for a signed-in caller requires an action or
  membership in this application.
- **Loosening is loud.** Every widening is classified by Control and held for a human approval with its
  blast radius in plain words.
- **ADR-0022 holds in spirit.** The proxy stays the only component that decides whether a request reaches
  the application. The application performs authorization (object-level checks) only.

## Three levels

| Level                                                                                                  | Holds against an agent that edits any app file? | Carries                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Opinionated framework — platform part** (proxy, IAM, Control, provider, platform-owned server build) | yes                                             | callers and requirements per endpoint, approval, credential custody, provider exposure, admission, headers |
| **Opinionated framework — in-process part** (types, `Ref`, data layer, generated entrypoint)           | no — best-effort, makes bypass conspicuous      | object-level access, field projection, scoped queries                                                      |
| **Lint rules** (run in the platform-owned server build, no inline suppressions)                        | yes, while the platform owns the build          | patterns types cannot express: imports, globals, logging, frontend sinks                                   |
| **Agent skills** (builder catalog and skill)                                                           | no — advice only                                | the right first attempt, and when to stop and ask the human                                                |

## 1. The contract

`fabrika.contract.ts` is a pure-data, browser-safe module. It replaces `fabrika.schema.ts` and
`fabrika.gates.ts`. It declares:

- the authorization vocabulary: scope dimensions with containment, actions, roles listed by exact action,
  and who may manage membership;
- every mount with its callers, once;
- every endpoint with its access requirement and its input and output schemas;
- files, jobs, webhooks, exports and imports (see the companion ideas).

Table policies live in `src/db/tables.ts` (see [scoped database access](scoped-database-access.md)) and are
compiled into the same approved artifact.

```ts
export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: {
			creator: 'owner',
			members: { manage: 'notes.admin', list: 'notes.read' },
		},
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.share': 'Create share links for a note',
		'notes.admin': 'Manage the workspace and its members',
		'workspaces.create': 'Start a workspace',
	},
	roles: {
		starter: { grants: ['workspaces.create'] }, // assigned by an IAM administrator
		editor: {
			grants: ['notes.read', 'notes.write', 'notes.share'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
		owner: {
			grants: [
				'notes.read',
				'notes.write',
				'notes.delete',
				'notes.share',
				'notes.admin',
			],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		me: c.query({ output: Me, access: { member: true } }),
		notes: {
			list: c.query({
				output: NoteList,
				access: { action: 'notes.read', over: 'workspace' },
			}),
			create: c.mutation({
				input: CreateNote,
				output: Note,
				access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
			}),
			remove: c.mutation({
				input: ById,
				output: Deleted,
				access: { action: 'notes.delete', on: 'note', from: 'id' },
			}),
			share: c.mutation({
				input: ShareNote,
				output: ShareLink,
				access: { action: 'notes.share', on: 'note', from: 'id' },
			}),
		},
		workspaces: {
			create: c.mutation({
				input: NewWorkspace,
				output: Workspace,
				access: { action: 'workspaces.create', creates: 'workspace' },
			}),
			invite: c.mutation({
				input: Invite,
				output: Invited,
				access: { action: 'notes.admin', in: 'workspace', from: 'workspaceId' },
			}),
		},
	}),
	machine: c.rpc('/machine', { callers: ['machine'] }, {
		importNotes: c.mutation({
			input: Import,
			output: Imported,
			access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		}),
	}),
	shared: c.link('/s', {
		spa: 'dist/share',
		dimension: 'note',
		grants: ['notes.read'],
		issuedBy: 'notes.share',
		maxDays: 30,
		procedures: (l) => ({ note: l.query({ output: SharedNote }) }), // served at POST /s/api/note
	}),
	health: c.health('/healthz'),
	github: c.webhook('/hooks/github', {
		scheme: 'github-sha256',
		boundTo: 'workspace',
		actions: ['notes.write'],
		input: Push,
	}),
	contact: c.form('/contact', { input: Contact, appendTo: 'contact_messages' }),
	spa: c.spa('/', { dir: 'dist/app', access: { member: true } }),
}))
```

### Callers

A mount names its callers once. Endpoints never repeat it.

| Caller     | Credential the proxy accepts                                     | Principal in the handler |
| ---------- | ---------------------------------------------------------------- | ------------------------ |
| `human`    | the IAM session, or a `px_` key bound to a user principal        | `UserPrincipal`          |
| `machine`  | a `px_` key bound to a service principal                         | `ServicePrincipal`       |
| `link`     | an anonymous share key bound to one object, as a bearer          | `LinkHolder`             |
| `app:<id>` | the connector credential of application `<id>`, same environment | `AppPrincipal`           |

There is no `public` caller. Anonymous traffic exists only through the fixed kinds in
[section 4](#4-anonymous-endpoints-are-fixed-kinds). An RPC mount cannot be public; the type does not allow
it.

### Access requirements

Every endpoint of a credentialed mount declares `access`. There is no default and no `none`.

| Form                               | The proxy checks                           | The framework additionally does                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ member: true }`                 | the token holds any permission of this app | nothing; the handler gets no data handle                                                                                                                                                                             |
| `{ action, over: dim }`            | the token holds `action` in some scope     | hands the handler `Within<dim, action>` from `scopedTo`: an app-level grant gives `Within.all`, an empty set is 403                                                                                                  |
| `{ action, in: dim, from: field }` | the token holds `action` in some scope     | checks `can(action, dim:value)`, and when a table owns the dimension also that the object exists (404 otherwise); removes `field` from `input`; hands `Ref<dim, action>`                                             |
| `{ action, on: dim, from: field }` | the token holds `action` in some scope     | resolves the containment chain with a **generated** locator, checks the action on any link of the chain, removes `field`, hands `Ref<dim, action>` carrying the whole chain; a missing or out-of-scope object is 404 |
| `{ action, creates: dim }`         | the token holds `action`                   | asks IAM to mint a fresh scope value and grant the caller the dimension's `creator` role; hands `ctx.created: Ref<dim, action>` for inserting the new row                                                            |

- **A `Ref` and a `Within` carry their action.** `Ref<'note', 'notes.read'>` cannot be passed to an
  operation that needs `notes.delete`; the [data layer](scoped-database-access.md) checks it at runtime as
  well. Both are classes with a private field; handler code cannot construct them.
- Actions are typed from the contract (`'notes.raed'` → `Did you mean 'notes.read'?`).
- Roles list exact actions. `'*'` and `'notes.*'` do not type-check, and IAM refuses them.
- A link mount's procedures are declared through `(l) => ({ … })`, where `l.query` admits only the link's own
  dimension and grants; `link` is not a valid caller of an RPC mount, and `c.spa` callers are always `human`.
- `output` is required, and a loose output schema (`.passthrough()`) does not type-check. The type rejects a return value with undeclared fields, and the runtime projects
  the response through the schema. Input object schemas are strict.
- Containment (`note` is in `workspace`) is new semantics: `@fabrika/auth-core` scopes are flat today. The
  framework resolves the chain; IAM still evaluates each link as a flat scope.

### RPC with one path per procedure

`notes.remove` is served at `POST /api/notes.remove` with the input as the body. It is still RPC — the path is
the procedure name, not a resource — in the style of gRPC, Twirp, Connect and tRPC. The typed client calls
`api.notes.remove({ id })`. The proxy cannot read bodies; with the name in the path it enforces callers and
the requirement per procedure. The `{ batch }` form is dropped. All procedures are `POST`, so inputs never land
in URLs, logs or browser history.

## 2. The proxy decides, per endpoint

The approved artifact compiles to one row per endpoint: `{ id, kind, method, path, callers, requirement }`.

- **One matcher in `@fabrika/auth-core`**, run only by the proxy. The application never matches paths: it
  dispatches by the endpoint id the proxy sets, so router/proxy divergence is impossible rather than tested, and
  the root rule "only the proxy runs the evaluator" holds unchanged.
  - A non-canonical path is refused with 400: empty segment, `.`/`..`, encoded `/` or `\`, trailing `/`.
  - The most specific endpoint wins: a literal segment beats a parameter, which beats a wildcard. The
    compiler refuses two patterns that serve the same requests.
  - An RPC mount reserves its prefix: an unknown procedure is denied, never served by the SPA.
- **The decision, in one pass over the selected endpoint:**
  1. A `px_` key is present (a share link is one) → mint from it; the resulting kind (`human`, `machine`,
     `link`, `app:<id>`) must be one of the endpoint's callers; terminal. Workload credentials of jobs and
     webhooks are their own kind, which no mount accepts.
  2. No key and `human` is a caller → the session, or the login redirect.
  3. The token must satisfy the requirement (an action in some scope, or membership). Otherwise 403.
  4. **Admission** for a session-authenticated non-GET request: `Sec-Fetch-Site: same-origin`, and for RPC
     `Content-Type: application/json`. Upload endpoints admit their declared body type instead.
- **The proxy-to-application hop is authenticated.** Today a valid token plus a direct dial is enough to reach
  an application service on a shared Zerops network, and nothing proves the proxy selected the endpoint. The
  proxy:
  - strips every client-supplied `X-Fabrika-*` header;
  - sets `X-Fabrika-Endpoint` and `X-Fabrika-Revision` (the approved revision it published) from its own
    decision; the application refuses a request for a revision other than its own (see activation in
    [section 7](#7-approval));
  - proves itself to the upstream with a per-application secret the platform injects into both (a managed
    variable), which the application checks before anything else. The generated readiness check is an `exec`
    probe inside the container, so it needs no exemption from this check.
- The path-dependent half of the decision is one pure function, `planEndpoint(table, method, path)`. The proxy
  runs it; Control's classifier and the build report call the same function. There is no second implementation.

A narrower endpoint now really narrows. Today an absent credential falls through to every later matching rule
(`packages/proxy-core/src/authorize.ts:167`), so a gate can only add access.

## 3. The implementation cannot add surface

```ts
export default implement(contract, {
	database, // tables and policies: the framework generates locators and form inboxes from it
	deps: (env) => ({ files: createFiles(env) }),
	handlers: {
		api: {
			notes: {
				list: ({ ctx }) => ctx.deps.db.notes.list(ctx.within),
				remove: async ({ ctx }) => {
					await ctx.deps.db.notes.remove(ctx.target)
					return { deleted: ctx.target.value }
				},
			},
		},
	},
})
```

- The generated entrypoint calls `boot(app, { env, iam, origin })` with the platform ports, then dispatches each
  request by the endpoint id the proxy set.
- `implement` is type-checked against the contract. A handler for an undeclared endpoint, a missing handler, or
  a handler for the wrong kind is an error (`'adminDump' is not in the contract. Declare the endpoint in
  fabrika.contract.ts first.`).
- There is **no slot** for middleware, raw routes, `authenticate`, a custom server or WebSocket upgrades. The
  entrypoint is generated. The framework verifies the injected token itself against IAM's JWKS from the
  platform-owned `FABRIKA_IAM_ISSUER`.
- **Credential custody.** Database and storage credentials arrive under framework-only names (added to Control's
  `assertUnmanagedName`, so neither the builder nor an operator can set them). The framework reads them while
  building `deps` and deletes them from `process.env`. This is in-process best-effort: `/proc/self/environ` and
  child processes still see the original environment. The real limit is what the credential can do — the runtime
  role has DML on its own schema only, and the migration credential never enters the container (see the
  [data layer](scoped-database-access.md)).
- **The platform owns the run section.** On Zerops the provider generates `run.start`, `run.crontab` and the
  readiness check from the contract. OS packages the application needs (PDF or image tools) are a typed,
  allowlisted list in the contract that the provider turns into `run.prepareCommands`. An authored `run`
  section, a non-generated crontab entry or a missing readiness check is refused.
- **The platform owns the server build.** A check that runs first and is followed by commands the application
  authors proves nothing: a later command, a `tsconfig` `paths` entry, a `bunfig.toml` `preload` or a patched
  dependency changes what actually runs (both reviews reproduced this). So:
  - the provider generates the whole server build: fixed commands from the generated entrypoint, the platform's
    own `tsconfig`, fixed `deployFiles`; the application authors commands only for its SPA, and the SPA output is
    never part of the server's module graph;
  - the build refuses `tsconfig` `paths`/`baseUrl` that touch `@fabrika/*`, `bunfig.toml` `preload`,
    `patchedDependencies`, `overrides`, and local, `file:` or git dependencies; it verifies the lockfile hashes of
    `@fabrika/*` against the published packages;
  - the build runs without application secrets; a `${RUNTIME_…}` reference in build variables is refused;
  - the check runs `tsc --noEmit` (with `as`, `any`, `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck`
    refused), the lint rules of [section 9](#9-lint-rules) over the bundled module graph with inline
    suppressions refused, and the contract compiler, on the final artifact.
  - This is not Control executing application code (ADR-0005): it runs in the provider's build container. In v1
    it exists on Zerops only; on Cloudflare the application config is still imported inside the credentialed
    runner, so a Cloudflare application's in-process and lint layers are advisory until the runner separates a
    credential-free compile step.
- At startup the application compares the digest of its contract with `FABRIKA_CONTRACT_DIGEST`, written by the
  deploy from the approved artifact, and refuses to start on a mismatch (the readiness check fails; on
  Cloudflare a module-scope throw fails the upload).

## 4. Anonymous endpoints are fixed kinds

| Kind        | What it can do                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c.health`  | answers a constant status; no data handle                                                                                                                                                                                                                                         |
| `c.form`    | appends one row to one declared inbox table, declared columns only; answers a constant; body limit; reads nothing; the inbox's read action must be an app-level grant, never in a role with `member.scope` (otherwise everyone who can create a workspace reads every submission) |
| `c.webhook` | see below                                                                                                                                                                                                                                                                         |
| `c.link`    | serves a separate share SPA and its procedures to an anonymous key bound to one object (see [section 6](#6-membership-and-share-links-are-iam-features))                                                                                                                          |

**Webhooks are bound to a scope.** A signature proves who sent a delivery, not which tenant it may affect.

- **v1 supports GitHub only.** Slack signs with one secret per Slack app and its signature does not cover the
  URL, so one tenant could replay its own signed delivery to another tenant's binding; Stripe generates its own
  secrets. Both wait until bindings can be tied to a provider account id.
- A webhook declares `boundTo: 'workspace'` (or `boundTo: 'app'`, a widening that needs a reason).
- A workspace member holding the dimension's `members.manage` action creates a binding through a generated
  endpoint. The binding records the provider account it accepts (GitHub `installation.id` or repository id); the
  platform generates the secret (minimum entropy, never typed by a human) and the URL `/hooks/github/<bindingId>`.
  Binding rows live in IAM, not in the application's schema.
- Verification runs in-process (Caddy's `forward_auth` passes no body), in the generated webhook handler: the
  signature over the raw body, then the payload's account id against the binding, then deduplication by delivery
  id. GitHub signatures carry no timestamp, so deduplication is the replay defence. There is no custom verify
  function.
- The handler runs with a credential narrowed to the webhook's declared `actions`, in the bound workspace only,
  and receives `Ref<'workspace', action>` for it. It cannot reach another workspace even with a correct
  signature.

**Forms** have a per-client rate limit only where the proxy knows the client address; on Zerops that needs the
balancer's client address to be trustworthy first. Until then the limit is per form.

There is no anonymous read API and no self-signup. An application that needs a genuinely public surface is
outside this model.

## 5. Frontend: a React SPA, with header profiles

The frontend is a React single-page application served by `c.spa`. There is no server-side rendering: every
data access goes through a declared endpoint.

- The SPA is served only to callers who satisfy its requirement (typically `member`). A signed-in person with no
  permission in the app gets the proxy's 403 page.
- The SPA calls the typed client generated from the contract.
- **The proxy sets headers by endpoint kind**; the application cannot set or override them.

| Profile    | Headers                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spa`      | `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <operations ingest>; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` with every powerful feature off |
| `link-spa` | as `spa`, plus `Referrer-Policy: no-referrer` and `Cache-Control: no-store`                                                                                                                                                                                                                                                                                                                                                                                     |
| `rpc`      | `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `file`     | see [file storage](app-file-storage.md): `sandbox; default-src 'none'`, `nosniff`, `private, no-store`                                                                                                                                                                                                                                                                                                                                                          |

- `script-src` stays strict; a Vite production build emits external scripts only. `style-src` allows inline
  styles, because common React libraries inject `<style>` elements and blocking them would push the agent toward
  a much wider exception. The builder ships a tested UI stack; development uses a separate, looser policy that
  never reaches a deploy.
- CSP limits where the page may send data; it is not a general defence against exfiltration by the application's
  own code.
- The Operations ingest origin is added by the platform.
- **The contract may extend `connect-src`, `img-src` or `frame-ancestors` with named origins and a purpose.** An
  extension lets the frontend send data elsewhere or be framed, so it is a **widening**.

## 6. Membership and share links are IAM features

**Membership.** Every operation is evaluated by IAM against the caller's own token and the approved contract.
The application supplies no actor and writes no grant. **Only endpoints whose action is the dimension's
`members.manage` action get `ctx.members`:** the proxy attaches a single-use delegation grant, bound to that endpoint and
request, and IAM requires it. A handler such as `me` cannot spend an owner's authority, and an application-audience
token alone is not a bearer for delegation.

| Operation                              | Rule                                                                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creates: 'workspace'`                 | IAM mints the scope value (never the application); grants the caller the `creator` role                                                                                                                                                                          |
| `ctx.members.assign(ref, email, role)` | the caller holds the dimension's `members.manage` action there; the role is `assignableBy` one of the caller's roles there; the role grants nothing the caller lacks there; the invitee's email must be verified by the identity provider; an invitation expires |
| `ctx.members.revoke(ref, principal)`   | `members.manage` there; cannot revoke a role the caller could not assign; cannot remove the last holder of the `creator` role                                                                                                                                    |
| `ctx.members.list(ref)`                | the dimension's `members.list` action there; returns labels and roles, emails only to `members.manage`                                                                                                                                                           |

- A **workload** caller (jobs, webhooks, connectors) cannot use `creates` or any membership operation. This
  closes "a form plus a job that invites the submitted email" as a back door to self-signup.
- IAM refuses a **global** grant of a role declared with `member.scope`, and refuses wildcards in custom roles
  of an application that has a contract. An IAM administrator granting a role shows the holder count.

**Share links.**

- Issuing: `ctx.links.issue(ref, { days })` from an endpoint whose `Ref` carries the link mount's issuing
  action (`notes.share`). IAM issues an anonymous credential bound to the **whole containment chain**
  (`note:n1`, `workspace:w1`), the application and the environment, with a required expiry no longer than the
  mount's `maxDays`, and grants frozen to the mount's `grants`. On every link request the framework resolves the
  chain from the database and refuses the request when it differs from the bound chain, so a link issued for a
  wrong chain, or for a note moved since, stops working.
- Removing a link mount revokes every key it issued.
- Revoking: by the issuer, or by `members.manage` on the containing scope; IAM lists a scope's links.
- **Delivery without a cookie.** The link URL is `/s/#<key>`. The fragment never reaches a server or a
  `Referer`. A generated bootstrap script reads it, removes it from the URL with `history.replaceState`, and keeps
  the key in a closure **before** telemetry or application modules load; error SDKs would otherwise record the full
  URL. Operations also redacts URL fragments, `Authorization` headers and `px_` patterns in events and breadcrumbs
  before storing them. The share SPA sends the key as `Authorization: Bearer` on its procedure calls; files are
  fetched the same way into `blob:` URLs. The proxy's single long-lived cookie path (ADR-0022) is unchanged.
- The holder reaches only the `link` mount, only for that object and its declared children. A file collection
  is reachable by links only if it says `link: true`, which is a widening.

## 7. Approval

**What is approved is one immutable revision**, read from the commit being deployed:

- the compiled contract (`fabrika.contract.json`) and the compiled table policies with their generated locators;
- the provider's exposure facts for the target (storage policies, subdomain access, bindings, CSP extensions);
- the digest of the platform check's rule set and version.

Control reads the artifacts from the exact commit (the tarball on Zerops; on Cloudflare a single-file fetch at
the commit resolved by ADR-0048), never from a builder upload or a runner's output. Today both happen: the builder
uploads a locally compiled artifact that carries gates (ADR-0042 §8), and Cloudflare's `reconcile-schema` reads
the roles from the runner's outcome. Both paths change: uploads carry no gates and no exposure facts, and the
schema comes from the commit.

**One function publishes.** Every write path builds the proxy table and the IAM reconcile through
`approvedRevision(app, env)`: the deploy run, `apps.environments.put` (the builder path), the namespace proxy
republish, namespace reconcile and `reconcile-schema`. A pending widening is published nowhere. Publication is
a compare-and-swap on the environment's revision, so a concurrent change cannot publish against a stale
classification.

**Activation.** A revision becomes active in a fixed order: the application version that carries it becomes
ready, then IAM grants, then the proxy table. The proxy stamps every forwarded request with its revision, and the
application refuses a request for any other revision with 503. A request can therefore never be served by
revision A's code under revision B's grants. The existing namespace lease (Control's `republishUnderLease`) still
serializes publication; the revision compare-and-swap is in addition to it.

**Classification** compares, for every caller population, **which actions over which tables and columns it can
reach** in the candidate versus the active revision. Endpoints are only the means.

| Class     | Examples                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| widening  | a population gains a column or table it could not reach; a new mount or caller kind; a weaker requirement; a new webhook, form, link mount or link-reachable collection; a role gaining an action; a membership rule change; a table policy change; a connector edge; a job gaining an action; a CSP extension; a provider exposure fact |
| additive  | a new endpoint whose access form and reachable tables and columns are already approved for the same population; a new action no role grants; a changed schedule or limit that grants nothing                                                                                                                                             |
| narrowing | anything that removes or tightens                                                                                                                                                                                                                                                                                                        |

A new endpoint that exposes nothing new therefore applies without a prompt, and one that adds a column to what
editors can see is held. Holder counts for an action in a `creator` role count everyone who can create a scope,
because each of them can become a creator.

- **The prompt is a plain-language access report**, not a diff: _"Editors (88 people in 31 workspaces) will be
  able to export all notes of their workspaces as PDF."_ It states role holder counts and the identity provider's
  openness.
- **Approvers** hold `deploy.approve-access`; service principals cannot approve. A change made through the
  builder is attributed to the human who consented to the builder session (ADR-0042), not to its machine key.
- **Approval requires WebAuthn with user verification.** A silent OIDC re-authentication or a typed confirmation
  can be driven by an agent that controls the browser; a platform authenticator's user-verification prompt cannot.
- **A solo developer** may approve their own change this way. An organization can require a second approver, at
  least for anonymous kinds.
- **Every environment except `local` is protected by default.** Unprotecting one is an IAM-administrator action
  outside `app.manage`, and it is audited.
- **Rollback** to the immediately previous approved revision needs no new approval when the current revision was
  a widening. A narrowing invalidates every older approval, so rolling back a narrowing needs a new approval, and
  a deliberately removed access cannot return by redeploying an old commit.

## 8. Platform prerequisites

The guarantees above do not hold without these.

**IAM**

- App tokens carry only grants of that application; cross-app (`app IS NULL`) grants reach registered admin
  audiences only.
- `member` defined against the application's own catalog.
- Exact actions in every role of a contract application; no global grant of a membership role.
- The delegation API of [section 6](#6-membership-and-share-links-are-iam-features), with verified-email invites.
- Share links bound to object, application and environment, with a required expiry.
- **Environment in identity:** tokens carry the environment, and every grant, key and link is bound to one.
- **Workload credentials** per job, webhook binding and connector import, each narrowed to its declared actions
  and scopes. Job and webhook credentials have an audience fixed to their own application and a principal kind no
  mount accepts; a connector credential's audience is the owner application, usable only on the export's paths.
  All of them live in the same container environment, so the narrowing between them is in-process only.
- **A narrowed application-facing IAM surface.** Today a Cloudflare application holding the `IAM` binding can call
  `issueKey` with the token of a user it is serving and create a service key with that user's permissions at the
  application and no expiry (`packages/iam/src/issue.ts:76`, `expiresAt ?? null`). Applications get JWKS,
  delegation and link issuing only; `issueKey`, `revokeKey` and `listPrincipals` refuse application-audience
  tokens.
- A refresh path so a grant change takes effect before the five-minute token expires, and a bound on token size
  (a user in many workspaces must not produce a JWT larger than a proxy header limit).
- Holder counts for the approval prompt.

**Providers**

- **Never** an application route, `workers_dev` or Zerops subdomain access on an application service. There is no
  approval path for these: the proxy is the only public entry (ADR-0022).
- Refuse every storage policy that is not private, including `custom` with a raw policy. Because a re-applied
  import ignores changed fields on existing services, Control **reads back** bucket policies, R2 public access
  (`r2.dev`, custom domains) and subdomain access before every activation. A read-back that is not private, or
  that cannot be completed, blocks activation and raises an Operations alert.
- Cloudflare: the platform deploys the proxy Worker; the application's config no longer builds its own front
  door. Refuse bindings to another application's Worker, D1, KV or R2.
- **Zerops database isolation:** remove `postgres` from the hostnames an application may reference
  (`packages/provider-zerops/src/service-references.ts:8`), so `${postgres_connectionString}` cannot bring the
  shared credential back; create one Postgres role per application with grants on its own schema only, and a
  separate migration role. This changes ADR-0014's invariant that Fabrika never resolves the shared connection
  value.
- The generated `run` section and the platform-owned server build of
  [section 3](#3-the-implementation-cannot-add-surface).
- Application migrations run by Control with a vault-held migration credential (see the
  [data layer](scoped-database-access.md)).

**Provider capability in v1.** The data layer is Postgres-only, so files, jobs and connectors that need the data
layer are Zerops-only in v1. A Cloudflare application gets the contract, the proxy and the frontend.

**Ship first, independent of the rest:** the router drops empty path segments (`packages/app/src/router.ts:46`)
while the gate matcher reads the raw path, so `//admin/users` reaches the `/admin/users` handler under different
gates. Answer 400 for non-canonical paths. Correct the comment at `packages/control/fabrika.gates.ts:17`, which
claims a narrower rule overrides a broader one.

## 9. Lint rules

Run by the platform-owned check. Inline suppressions are refused; the rule set is versioned by the platform, and
its digest is part of the approved revision.

| Rule                                                                                                                 | Why                                                      |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| No import of a database driver, S3 client, `jose`, `node:http`, `node:net`, `node:child_process` in application code | bypasses around the framework                            |
| No use of the `Bun.sql`, `Bun.SQL`, `Bun.serve`, `Bun.spawn`, `Bun.connect` globals                                  | the same bypasses without an import                      |
| No `sql` template or `sql.raw` anywhere in the application, stores included                                          | raw SQL escapes the scoped layer                         |
| No `Ref<string, …>` / `Within<string, …>` and no assignment to a prototype in application code                       | widening a capability without a cast; patching the guard |
| No reads of `process.env` outside the generated entrypoint                                                           | credential custody                                       |
| No `fetch` to another application's origin; no `px_` literal or stored key used as a bearer                          | hand-written integrations                                |
| No loose output schemas (`passthrough`, `z.any()`, `z.record(z.unknown())`); input objects strict                    | leaked fields, mass assignment                           |
| Flag input fields named `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId` outside an `in`/`on` access      | trusted client identity                                  |
| No `console.*` of an error object, request, headers or env                                                           | secrets in logs                                          |
| SPA code reads no `import.meta.env` except `FABRIKA_PUBLIC_*`; the bundle is scanned for declared secret values      | secrets in the browser                                   |
| No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in SPA code                                      | XSS acts as the signed-in user                           |
| No `.skip`, `.only` or tests without assertions; generated isolation tests exist and match their content hash        | a green suite must mean something                        |

## 10. What the agent skill says

- Declare every endpoint in `fabrika.contract.ts` first, then implement it.
- Use `on` for anything addressed by id, `over` for lists, `in` for creation inside a scope.
- Never use `member: true` for an endpoint that returns application data.
- When a request answers 401 or 403, do not change the contract, the table policy or IAM roles to make it pass.
  Tell the human which role the caller lacks.
- Before adding an endpoint kind other than a query or mutation on an existing mount, a CSP origin, a connector,
  a job action or a table policy change, explain to the human in one sentence what it lets someone do, and wait
  for a yes.
- Never edit `zerops.yaml` run sections, the build check or generated files.

## Summary by level

| Protection                                                        | Platform                                                    | In-process                                         | Lint                  | Skill |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- | --------------------- | ----- |
| Every endpoint declares access                                    | proxy denies undeclared paths                               | types, `implement`                                 |                       | ✔     |
| No public RPC, no `none` for signed-in callers                    | proxy table                                                 | types                                              |                       |       |
| Authenticated ≠ authorized                                        | proxy requirement                                           |                                                    |                       | ✔     |
| IDOR, wrong operation on the right object                         |                                                             | action-bound `Ref`, generated locators, data layer | no `sql`              | ✔     |
| Client-supplied identity                                          |                                                             | `in`/`on` remove the field                         | field-name flag       | ✔     |
| Leaked fields                                                     |                                                             | output type + projection                           | loose schemas         |       |
| Widened front door, role or table policy                          | approval of the revision; IAM guardrails                    |                                                    |                       | ✔     |
| Router/proxy divergence; forged endpoint header                   | one matcher; stripped headers; proxy secret                 |                                                    |                       |       |
| Bypass via raw server, raw SQL, env credentials, module remapping | generated run section and server build; narrow runtime role |                                                    | imports, globals, env |       |
| CSRF                                                              | proxy admission                                             |                                                    |                       |       |
| XSS, clickjacking                                                 | header profiles                                             |                                                    | SPA sinks             |       |
| Secrets in browser or logs                                        | bundle scan                                                 |                                                    | env, console          | ✔     |
| Provider exposure, cross-app resources, shared DB credential      | provider refusals, read-back, per-app role                  |                                                    |                       |       |
| Cross-environment credentials                                     | IAM                                                         |                                                    |                       |       |

## Binding rules that change

Settle these before implementation, not after:

- **Root `CLAUDE.md`, "exactly one gate evaluator … only the proxy runs it":** holds unchanged, because the
  application dispatches by the proxy-set endpoint id and never matches paths. The `proxy` / `proxy-core`
  CLAUDE.md invariants ("array order is precedence") change with ADR-0022 §3.
- **Control `CLAUDE.md`, "never add a second same-origin check":** when Control moves onto the contract, the
  proxy's admission replaces Control's `sameOrigin`; one of the two is removed explicitly.
- **ADR-0022:** §3 (most-specific endpoint, requirement and admission at the proxy); the invariant "IAM issues every
  `px_` credential from its admin surface" (links issued through delegation, workload credentials); the invariant
  "a header a client can set never reaches a decision" is preserved by stripping `X-Fabrika-*`; the `createIam`
  invariant (the framework verifies via JWKS over HTTPS).
- **ADR-0012:** its rejected alternative ("move gates into route or RPC definitions") becomes the decision, met by
  compiled static data.
- **ADR-0014:** per-application Postgres roles, and the shared-credential invariant.
- **ADR-0005:** unchanged in letter; the platform check runs in the build, not in Control.
- **ADR-0042:** builder changes attributed to the consenting human; the builder key cannot approve; §8/§9 change
  because uploaded artifacts no longer carry gates or exposure facts.

## Migration

`@fabrika/app` and `@fabrika/auth` are published at 0.0.4; this is a breaking change.

1. Router canonical-path fix and the gates comment.
2. The ADR and root-rule revisions above.
3. IAM: app-only grants, `member`, the narrowed application surface, exact roles, environment binding.
4. The contract kit, matcher and compiler; the proxy endpoint table behind a new manifest version; stripped
   headers and the proxy secret.
5. Control: approved revisions on every write path.
6. Provider lock-down: generated run section and platform check, storage refusals and read-back, per-app
   Postgres roles.
7. The data layer; then files, jobs, link mounts, delegation, connectors.
8. Migrate IAM, Control and Operations. Operations splits its public and private surfaces by host, which the
   contract does not model yet.

## Alternatives considered

- **Keep `fabrika.gates.ts` and add a consistency check.** Catches disagreement, not widening.
- **Code-first: mounts inside `defineApp`, gates extracted by importing the app at build.** One place to write,
  but the build executes the app's module graph, and what is extracted is the app's self-report.
- **File-based routing: the folder is the audience.** Control could derive mounts from file names alone, but
  per-endpoint requirements stay invisible to it, and URLs move with files.
- **Resource-first: tables with policies and generated CRUD.** Strong for CRUD, with an expressiveness cliff for
  everything else. A candidate for later sugar on top of the contract.
- **No anonymous surface in applications; a platform intake service for webhooks and forms.** Safer, but a large
  new service. The fixed kinds keep the option open.
- **A platform data executor holding the database credentials.** The only design that makes object-level access
  independent of application code. The long-term hardening path.

## Open questions

- Where do contract-driven proxy tables meet Operations' host-split surface?
- How are grant changes and the token lifetime reconciled across several proxy instances?
- Is approval fatigue acceptable with "every new endpoint is a widening", or should endpoints whose action and
  output equal an existing endpoint's be additive?
