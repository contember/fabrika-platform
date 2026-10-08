# Opinionated application framework

A proposal to make the Fabrika application framework opinionated before production applications are built on it.
The goal: **the safe way to write an application is the easiest way, and the common mistakes of a coding agent are
a type error or a runtime refusal.** The framework runs on today's platform; it needs no change to the proxy,
Control or the providers.

A second proposal, [platform enforcement](platform-enforcement.md), makes the same declarations binding outside the
application process, against an agent that edits any file to make a refused request pass. The two are separate:
this document gives most of the value on its own, and the platform reads the same contract later.

Companions, each with a framework part and a platform part:

- [Scoped database access](scoped-database-access.md) — a Kysely-based data layer reachable only through
  authorized capabilities.
- [Application file storage](app-file-storage.md) — files that inherit their parent object's access.
- [Scheduled jobs](app-scheduled-jobs.md) — cron work with declared actions.
- [Declarative application connectors](declarative-app-connectors.md) — typed, read-only data exchange between
  applications.

The work is planned in [the implementation plan](app-framework-implementation-plan.md).

## The mistakes it targets

A coding agent is competent but optimizes for "it works". These are its most likely security mistakes, in order:

1. **An endpoint with no authorization**, or authorization checked in one handler and forgotten in the next.
2. **Authenticated mistaken for authorized.** IAM mints a token for every person who can sign in, possibly with no
   permission in this application (`mintToken` in `packages/iam/src/tokens.ts`).
3. **Object-level access (IDOR).** The endpoint checks `notes.read`, then loads any note by id or lists every
   workspace — or holds the right object for the wrong operation.
4. **Trusting client-supplied identity or scope** (`ownerId`, `workspaceId` from the request body).
5. **Leaked fields** — a whole database row returned.
6. **Raw access around the framework** — a hand-written server, raw SQL, a database driver.

In agent-built applications broken access control is the leading vulnerability class, ahead of injection
([arXiv 2606.23130](https://arxiv.org/abs/2606.23130): 28.6 % vs 16.8 %). The OWASP
[API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) ranks broken object-level
authorization first.

## Principles

- **One declaration.** The application's access surface is one contract plus its table policies. Gates, the IAM
  vocabulary, the router, the typed client and the handler types are derived from it. Nothing is written twice.
- **Nothing is open by omission.** A missing access declaration is a type error and a path no gate admits.
- **Authenticated is never enough.** Every endpoint for a signed-in caller requires an action or membership in this
  application.
- **Capabilities, not ids.** A handler receives authorized objects (`Ref`) and authorized scopes (`Within`), never a
  raw id it must check itself.
- **Types first, runtime always.** The types catch the honest mistake. TypeScript checks method parameters
  bivariantly, so code can widen a `Ref` without a cast (shown by a spike); every capability is therefore checked at
  runtime as well.
- **Agent-friendly errors.** Every refusal names what is missing and the allowed form
  (`'notes.raed' — did you mean 'notes.read'?`).

## 1. The contract

`fabrika.contract.ts` is a pure-data, browser-safe module. It replaces `fabrika.schema.ts` and `fabrika.gates.ts`.
It declares:

- the authorization vocabulary: scope dimensions with containment, actions, roles listed by exact action, and who
  may manage membership;
- every mount with its callers, once;
- every endpoint with its access requirement and its input and output schemas;
- files, jobs, webhooks, exports and imports (see the companions).

Table policies live in `src/db/tables.ts` (see [scoped database access](scoped-database-access.md)).

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

**The contract is a literal.** Object and array literals, strings, numbers, booleans, the `c.*` and `z.*` calls, and
`const` imports of such values from schema modules. No computed values, no function calls of the application's own.
The checker enforces this from day one, so that the platform can later read the contract from source without
executing it ([platform enforcement](platform-enforcement.md)). Schemas are zod 4, restricted to a serializable
subset: strict objects, no transforms, no `passthrough`.

### Callers

A mount names its callers once. Endpoints never repeat it.

| Caller     | Credential                                                | Principal in the handler |
| ---------- | --------------------------------------------------------- | ------------------------ |
| `human`    | the IAM session, or a `px_` key bound to a user principal | `UserPrincipal`          |
| `machine`  | a `px_` key bound to a service principal                  | `ServicePrincipal`       |
| `link`     | an anonymous share key bound to one object, as a bearer   | `LinkHolder`             |
| `app:<id>` | the connector key of application `<id>`                   | `AppPrincipal`           |

There is no `public` caller. Anonymous traffic exists only through the fixed kinds of
[section 4](#4-anonymous-endpoints-are-fixed-kinds). An RPC mount cannot be public; the type does not allow it.

### Access requirements

Every endpoint of a credentialed mount declares `access`. There is no default and no `none`.

| Form                               | The framework                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ member: true }`                 | requires any permission of this application; the handler gets no data handle                                                                                                  |
| `{ action, over: dim }`            | hands the handler `Within<dim, action>`: the scope values where the caller holds the action; a global grant gives `Within.all`; an empty set is 403                           |
| `{ action, in: dim, from: field }` | checks `can(action, dim:value)`, and when a table owns the dimension also that the object exists (404); removes `field` from `input`; hands `Ref<dim, action>`                |
| `{ action, on: dim, from: field }` | resolves the containment chain with a generated locator, checks the action on any link of the chain, removes `field`, hands `Ref<dim, action>` with the chain; missing is 404 |
| `{ action, creates: dim }`         | asks IAM to mint a fresh scope value and grant the caller the dimension's `creator` role; hands `ctx.created: Ref<dim, action>` for inserting the new row                     |

- **A `Ref` and a `Within` carry their action.** `Ref<'note', 'notes.read'>` cannot be passed to an operation that
  needs `notes.delete`; the data layer checks it at runtime too. Both are classes with a private field, bound to the
  request that obtained them; handler code cannot construct them.
- Actions are typed from the contract. Roles list exact actions; `'*'` and `'notes.*'` do not type-check.
- A link mount's procedures are declared through `(l) => ({ … })`, where `l.query` admits only the link's own
  dimension and grants; `link` is not a valid caller of an RPC mount; `c.spa` callers are always `human`.
- `output` is required. A loose output schema does not type-check, a return value with undeclared fields does not
  type-check, and the runtime projects the response through the schema. Input objects are strict.
- Containment (`note` is in `workspace`) is new: `@fabrika/auth-core` scopes are flat today. The framework resolves
  the chain; IAM evaluates each link as a flat scope.

### One path per procedure

`notes.remove` is served at `POST /api/notes.remove` with the input as the body. It is still RPC — the path is the
procedure name — in the style of gRPC, Twirp, Connect and tRPC. The typed client calls `api.notes.remove({ id })`.
One path per procedure lets a gate apply per procedure, today and with platform enforcement. The `{ batch }` form is
dropped. All procedures are `POST`, so inputs never land in URLs, logs or browser history.

## 2. The implementation cannot add surface

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

- `implement` is type-checked against the contract. A handler for an undeclared endpoint, a missing handler, or a
  handler of the wrong kind is an error (`'adminDump' is not in the contract. Declare the endpoint in
  fabrika.contract.ts first.`).
- There is **no slot** for middleware, raw routes, `authenticate`, a custom server or WebSocket upgrades.
- The entrypoint is generated (`fabrika app build` writes `fabrika/entry.generated.ts`). It calls
  `boot(app, { env, iam, origin })`, which reads the framework's variables, deletes them from `process.env`, and
  serves.
- **Per request**, in this order:
  1. refuse a non-canonical path (an empty segment, `.` or `..`, an encoded `/` or `\`, a trailing `/`);
  2. select the endpoint with `planEndpoint`, the matcher in `@fabrika/auth-core`; an unknown procedure under an RPC
     prefix is 404, never served by the SPA;
  3. verify the proxy-injected token with the existing verifier and check that its principal kind is one of the
     mount's callers;
  4. check the requirement (`member`, or the action in some scope);
  5. admission for a session request that is not `GET`: `Sec-Fetch-Site: same-origin`, and
     `Content-Type: application/json` for RPC;
  6. parse the input strictly, run the access form, remove the `from` field, call the handler, project the output.
- Errors map to 400, 403, 404 and 409 with one envelope.

## 3. Running on today's platform

The contract compiles into the two things the platform already consumes:

- **`gatesFromContract(contract)`** produces the gates for `fabrika.config.ts`: one rule per endpoint path, in order
  of specificity. `human` becomes a `human` gate, `machine` and `link` become a `service` gate (a `px_` bearer), a
  mount with both gets the `service` rule first, and the anonymous kinds get `public`. A path with no endpoint has no
  rule, so the proxy denies it.
- **`schemaFromContract(contract)`** produces the IAM vocabulary (actions and roles) that the deploy reconciles today.

| Check                                        | Today, with the framework                                  | With platform enforcement            |
| -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| An undeclared path is unreachable            | proxy (generated gates)                                    | proxy (endpoint table)               |
| Caller kind (human, machine, link)           | proxy for session vs key; the framework for the key's kind | proxy                                |
| Requirement (`member`, action in some scope) | the framework                                              | proxy, and the framework again       |
| Object-level access, field projection        | the framework and the data layer                           | the same                             |
| Admission (same-origin, JSON)                | the framework                                              | proxy                                |
| Response headers                             | the framework                                              | proxy                                |
| A loosened contract or role goes unnoticed   | — (visible in the pull request only)                       | Control classifies, a human approves |

The router and the gates come from one table, so the router cannot serve a path under different gates than the
proxy evaluated — the divergence that exists today (`packages/app/src/router.ts:46` drops empty segments; the gate
matcher reads the raw path).

## 4. Anonymous endpoints are fixed kinds

| Kind        | What it can do                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `c.health`  | answers a constant status; no data handle                                                                                                                                                                          |
| `c.form`    | appends one row to one declared inbox table, declared columns only; answers a constant; body limit; reads nothing; the inbox's read action must be an application-level grant, never in a role with `member.scope` |
| `c.webhook` | see below                                                                                                                                                                                                          |
| `c.link`    | serves a separate share SPA and its procedures to an anonymous key bound to one object ([section 6](#6-membership-and-share-links))                                                                                |

**Webhooks are bound to a scope.** A signature proves who sent a delivery, not which tenant it may affect.

- **v1 supports GitHub only.** Slack signs with one secret per Slack app and its signature does not cover the URL,
  so one tenant could replay its own signed delivery to another tenant's binding; Stripe generates its own secrets.
- A webhook declares `boundTo: 'workspace'` (or `boundTo: 'app'`).
- A member holding the dimension's `members.manage` action creates a binding through a generated endpoint. The
  binding records the provider account it accepts (GitHub `installation.id` or repository id); the framework
  generates the secret and the URL `/hooks/github/<bindingId>`. Bindings live in a framework table of the
  application's database.
- The generated handler verifies the signature over the raw body, then the payload's account id against the
  binding, then deduplicates by delivery id. GitHub signatures carry no timestamp, so deduplication is the replay
  defence. There is no custom verify function.
- The handler receives `Ref<'workspace', action>` for the bound workspace only, for the declared `actions`.

There is no anonymous read API and no self-signup.

## 5. Frontend: a React SPA

- The frontend is a React single-page application served by `c.spa`. There is no server-side rendering: every data
  access goes through a declared endpoint, through the typed client generated from the contract.
- The SPA is served only to callers who satisfy its requirement (typically `member`); a signed-in person with no
  permission in the application gets a 403 page.
- **One response header policy** on every application response: `Content-Security-Policy: default-src 'self';
  script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' <operations ingest>; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` with every powerful feature off. Downloads get the
  file treatment of [file storage](app-file-storage.md).
- `style-src` allows inline styles, because common React libraries inject `<style>` elements. `script-src` stays
  strict; a Vite production build emits external scripts only.
- The contract may extend `connect-src`, `img-src` or `frame-ancestors` with named origins and a purpose.

## 6. Membership and share links

Multi-tenant applications need three IAM operations the framework calls on the caller's behalf. IAM evaluates each
against the caller's **live** permissions; the application supplies no actor and writes no grant.

| Operation                              | Rule                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `creates: 'workspace'`                 | IAM mints the scope value and grants the caller the `creator` role                                                                                                                                                       |
| `ctx.members.assign(ref, email, role)` | the caller holds the dimension's `members.manage` action there; the role is `assignableBy` one of the caller's roles there; the role grants nothing the caller lacks there; the email is verified; an invitation expires |
| `ctx.members.revoke(ref, principal)`   | `members.manage` there; cannot revoke a role the caller could not assign; cannot remove the last `creator`                                                                                                               |
| `ctx.members.list(ref)`                | the dimension's `members.list` action there; emails only to `members.manage`                                                                                                                                             |

- Only endpoints whose action is the dimension's `members.manage` action get `ctx.members`.
- A workload caller (jobs, webhooks, connectors) cannot create scopes or manage members. This closes "a form plus a
  job that invites the submitted email" as a back door to self-signup.

**Share links.**

- Issuing: `ctx.links.issue(ref, { days })` from an endpoint whose `Ref` carries the link mount's issuing action.
  IAM issues an anonymous key bound to the whole containment chain (`note:n1`, `workspace:w1`) and the application,
  with a required expiry no longer than `maxDays`, and grants frozen to the mount's `grants`. On every link request
  the framework resolves the chain from the database and refuses the request when it differs, so a link for a note
  moved since stops working.
- Revoking: by the issuer, or by `members.manage` on the containing scope. Removing a link mount revokes its keys.
  A revoked key keeps working until its cached token expires, at most 300 s.
- **Delivery without a cookie.** The link URL is `/s/#<key>`. The fragment never reaches a server or a `Referer`. A
  generated bootstrap script reads it, removes it with `history.replaceState`, and keeps the key in a closure before
  telemetry or application modules load. Operations redacts URL fragments, `Authorization` headers and `px_` patterns.
  The share SPA sends the key as `Authorization: Bearer`.
- The holder reaches only the `link` mount, only for that object and its declared children.

## 7. Data, files, jobs and connectors

- [Scoped database access](scoped-database-access.md): handlers reach rows only through `Ref` and `Within`; the
  query builder cannot express a query without its scope.
- [File storage](app-file-storage.md): a file collection is attached to an owner table and inherits its access.
- [Scheduled jobs](app-scheduled-jobs.md): a job declares its actions and receives `ctx.within` for them only.
- [Connectors](declarative-app-connectors.md): typed, read-only imports of another application's exported queries,
  usable only from declared endpoints.

## 8. The checker

`@fabrika/check` is a small syntactic checker over the application's source graph. It recognises no suppression
syntax. Today it runs in the template's build and in tests; with platform enforcement it runs in the platform's
build.

| Rule                                                                                                                 | Why                                                      |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| The contract, its schema modules and `src/db/tables.ts` are literals                                                 | the platform must read them without executing them       |
| No import of a database driver, S3 client, `jose`, `node:http`, `node:net`, `node:child_process` in application code | bypasses around the framework                            |
| No use of the `Bun.sql`, `Bun.SQL`, `Bun.serve`, `Bun.spawn`, `Bun.connect` globals                                  | the same bypasses without an import                      |
| No `sql` template or `sql.raw` anywhere in the application                                                           | raw SQL escapes the scoped layer                         |
| No `as`, `any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`                                      | type and lint suppression                                |
| No `Ref<string, …>` / `Within<string, …>` and no assignment to a prototype                                           | widening a capability without a cast; patching the guard |
| No reads of `process.env` outside the generated entrypoint                                                           | credentials stay with the framework                      |
| No `fetch` to another application's origin; no `px_` literal                                                         | hand-written integrations                                |
| Flag input fields named `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId` outside an `in`/`on` access      | trusted client identity                                  |
| No `console.*` of an error object, request, headers or env                                                           | secrets in logs                                          |
| SPA code reads no `import.meta.env` except `FABRIKA_PUBLIC_*`                                                        | secrets in the browser                                   |
| No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in SPA code                                      | XSS acts as the signed-in user                           |
| Migration file names match `YYYYMMDDHHMMSS_slug.sql`; crontab entries match the contract's jobs                      | agents without the CLI; no hand-written schedules        |
| No `.skip`, `.only` or tests without assertions; generated isolation tests match their content hash                  | a green suite must mean something                        |

The checker stops honest shortcuts. An aliased or indirect call can escape a rule; the runtime checks stay the real
boundary.

## 9. What the agent skill says

The same rules reach every agent: the builder catalog, the MCP server's instructions, and the template's
`AGENTS.md`.

- Declare every endpoint in `fabrika.contract.ts` first, then implement it. Keep the contract a literal.
- Use `on` for anything addressed by id, `over` for lists, `in` for creation inside a scope.
- Never use `member: true` for an endpoint that returns application data.
- When a request answers 401 or 403, do not change the contract, a table policy or IAM roles to make it pass. Tell
  the human which role the caller lacks.
- Before adding an anonymous endpoint, a CSP origin, a connector, a job action or a table policy change, explain to
  the human in one sentence what it lets someone do, and wait for a yes.
- Never edit generated files.

## 10. Testing

- `@fabrika/app/testing` sends a request through the same `planEndpoint` and requirement check as production, in
  front of the real dispatcher; `testCaller(grants)` uses `@fabrika/auth-core`'s `permits`.
- Generated isolation tests per scoped table (see [scoped database access](scoped-database-access.md)).

## What the framework does not guarantee

The framework runs inside the application process and in the application's own build. An agent that edits the
contract, a role, `fabrika.config.ts`, the build commands or the checker's invocation can loosen any of it, and only
the pull request shows the change. Making these declarations binding is
[platform enforcement](platform-enforcement.md).

## Alternatives considered

- **Keep `fabrika.gates.ts` and add a consistency check.** Catches disagreement, not widening.
- **Code-first: mounts inside `defineApp`, gates extracted by importing the application.** One place to write, but
  the build executes the application's module graph, and what is extracted is the application's self-report.
- **File-based routing.** Per-endpoint requirements stay invisible outside the application, and URLs move with files.
- **Resource-first: tables with policies and generated CRUD.** Strong for CRUD, with an expressiveness cliff for
  everything else. A candidate for later sugar on top of the contract.
- **A platform data executor that holds the database credentials.** The only design that makes object-level access
  independent of application code; an earlier spike built one and dropped it as too costly for the first users.

## Open questions

- Is a contract that must be a literal too restrictive for larger applications (shared schema fragments, generated
  CRUD)?
- Should the framework offer declared report kinds before the first production application, given the query
  builder's known gaps?
