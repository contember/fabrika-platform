# Secure-by-default application runtime

A proposal to make `@fabrika/app` and `@fabrika/auth` opinionated before production applications are
built on them. The goal is narrow: **minimize the chance that a coding agent, steered by an
inexperienced person, ships an application that grants unauthorized access.** Everything below is
judged against that goal.

Companion ideas:

- [Scoped database access](scoped-database-access.md) — row-level enforcement in the data layer.
- [Declarative application connectors](declarative-app-connectors.md) — data exchange between apps.

## Threat model

The person driving the agent does not read the diff. They describe a feature, the agent writes it, and
they deploy when it "works". The agent is competent but optimizes for "works": when a request is
refused, it loosens whatever refused it.

Catastrophic outcomes, in order of likelihood:

1. **An endpoint with no authorization.** The agent adds a route and forgets the check, or removes it
   to fix a 403.
2. **Authenticated is mistaken for authorized.** Every human who can sign in to the installation gets a
   token for every application (`mintToken` in `packages/iam/src/tokens.ts` mints with whatever
   permissions resolve, including none). An endpoint that checks only "is logged in" is open to the
   whole organization.
3. **Object-level access (IDOR).** The route checks `notes.read`, but the query loads any note by id, or
   lists every workspace.
4. **Trusting client-supplied identity or scope.** `ownerId`, `workspaceId` or `tenantId` taken from the
   request body instead of the token.
5. **Leaking fields.** A handler returns a whole database row, including columns the caller must not
   see.
6. **Widening the front door.** A `public` gate rule added so "the page loads".

Public evidence agrees with this ranking. In agent-built applications, broken access control is the
dominant vulnerability class, ahead of injection — see
[OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) (API1
BOLA, API3 property-level authorization) and
[arXiv 2606.23130](https://arxiv.org/abs/2606.23130).

## Principles

- **Nothing is open by omission.** Every way to expose an endpoint requires an explicit access
  declaration. Leaving it out is a type error, and also a startup error for code the type checker did
  not see.
- **The caller kind is always explicit.** There is no shorthand that implies "any authenticated
  caller".
- **Authenticated is never enough by default.** A non-public endpoint must also state an action, or
  state in words why it needs none.
- **Loosening is loud.** Each escape hatch carries a reason string, appears in a generated access
  manifest, and needs a human approval when it first reaches production.
- **Prefer mechanisms that do not depend on review.** Types, startup checks and deploy refusals work
  for a person who reads nothing. A review artifact helps only someone who reads it, so it is the last
  line, not the first.
- **ADR-0022 holds.** The proxy stays the only gate evaluator. Everything here is _authorization_
  (the second layer in [`overview.md`](../reference/overview.md)): it reads the verified token and can
  only narrow what the proxy admitted.

## 1. Every endpoint declares its access

Endpoints are declared as object literals rather than builder chains. A missing required property is
the clearest error an agent can get (`Property 'caller' is missing`), the shape is introspectable as
data, and a runtime check for JavaScript callers is a property lookup.

```ts
export const notesRouter = rpc.router({
	list: rpc.query({
		caller: 'user',
		permission: { action: 'notes.read' },
		input: z.object({ after: z.string().optional() }).strict(),
		output: noteListSchema,
		handler: ({ ctx, input }) =>
			ctx.db.table('notes').list({ after: input.after }),
	}),

	remove: rpc.mutation({
		caller: 'user',
		permission: { action: 'notes.delete' },
		input: z.object({ id: z.string() }).strict(),
		output: z.object({ deleted: z.string() }),
		handler: ({ ctx, input }) => ctx.db.table('notes').remove(input.id),
	}),

	me: rpc.query({
		caller: 'user',
		permission: { member: true }, // holds at least one permission in THIS app
		output: meSchema,
		handler: ({ ctx }) => ({
			id: ctx.auth.principal.id,
			label: ctx.auth.principal.label,
		}),
	}),

	health: rpc.query({
		caller: 'public',
		reason: 'platform health probe',
		output: statusSchema,
		handler: () => ({ ok: true }),
	}),
})
```

### Caller kinds

`caller` is required and has no default.

| `caller`       | Admits                                           | `ctx.auth` type          |
| -------------- | ------------------------------------------------ | ------------------------ |
| `'public'`     | anyone; requires `reason`; takes no `permission` | `AuthContext \| null`    |
| `'user'`       | a human principal                                | `UserAuth`               |
| `'machine'`    | a service principal (`px_` key or workload)      | `MachineAuth`            |
| `'principal'`  | a user or a service principal                    | `PrincipalAuth`          |
| `'share-link'` | an anonymous credential with frozen grants       | `ShareLinkAuth`          |
| `'custom'`     | the `check` function decides; requires `reason`  | the type `check` returns |

`ctx.auth` is narrowed by the literal, so a `'user'` handler can read `ctx.auth.principal.id` without
a null check, and a `'public'` handler cannot. The definition is a discriminated union over `caller`,
so the dispatcher narrows it with a `switch` and needs no cast.

A machine caller is named `machine`, not `service`, because the `service` gate kind also admits
user-bound `px_` keys.

### Permission

`permission` is required for every caller except `'public'`. Exactly one form:

| Form                                     | Meaning                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `{ action }` or `{ actions: [...] }`     | the actions this endpoint may exercise; rows are scoped by the data layer   |
| `{ action, scope: { dim: 'inputKey' } }` | a scope check against input, for resources the data layer does not own      |
| `{ member: true }`                       | the caller holds at least one permission in this app                        |
| `{ none: 'reason' }`                     | any caller of the declared kind; the reason is shown in the access manifest |

- `action` is typed from the app's `fabrika.schema.ts`, so a typo is a compile error. An action not in
  the reconciled schema is also a startup error.
- `{ member: true }` is the safe answer to "who am I" and landing-page endpoints. It closes threat 2
  without inventing an action.
- `{ none }` exists because some endpoints genuinely need no action. It is the one form that leaves
  threat 2 open, which is why it carries a reason and counts as a widening (section 3).
- Declared actions are checked once at entry: a caller who holds an action in no scope at all gets
  403 before the handler runs. Row scoping is the data layer's job (see the companion idea). An
  endpoint never checks the same scope twice.

### Input and output

- `input` is required whenever the endpoint takes input. Object schemas must be strict, so unknown keys
  are refused instead of silently forwarded into a write (mass assignment).
- `output` is required. The framework returns only the validated value. TypeScript alone does not stop
  a leak: a row variable with extra columns satisfies a narrower return type, because excess-property
  checks apply only to fresh object literals. Standard Schema does not promise to strip unknown keys
  (ArkType keeps them by default), so the docs and a lint require stripping or strict output schemas.
- `output: { raw: 'reason' }` is the escape hatch for a non-JSON response, and counts as a widening.

### Public mutations

A `'public'` mutation additionally requires `acknowledge: 'public-write'`. Without it the definition
does not type-check. An anonymous write is the single most dangerous thing an agent can add, so it
gets a second, unmistakable word.

### HTTP routes

HTTP routes take the same object, plus `method` and `path`. JSON APIs belong in RPC; HTTP routes are for
protocol surfaces: webhooks, files, HTML, health checks, ingest.

```ts
route({
	method: 'POST',
	path: '/webhooks/github/:connectionId',
	caller: 'custom',
	reason: 'GitHub HMAC signature',
	check: verifyGithubSignature, // (request, ctx) => T | null; null answers 401
	output: { raw: 'GitHub expects an empty 204' },
	handler: ({ custom }) => handleWebhook(custom),
})
```

A route that only the private network reaches (an internal RPC, an Operations `/private/*` path)
declares `exposure: 'private'`. The gate check (section 4) refuses a private route that a gate
matches. `exposure: 'private'` does not relax `caller`: network position is not identity. In a cheap
or mid Zerops namespace every application shares the project network, so another application can dial
a private route directly.

### Startup enforcement

`defineApp()` walks every route and procedure when the module loads and throws a configuration error
when:

- a definition is missing `caller`, `permission` (where required) or `output`, or was not created by
  `rpc.query` / `rpc.mutation` / `route` (a module-private `WeakSet` brands them without casts);
- an action is not in the registered schema;
- two routes duplicate each other, or an earlier wildcard shadows a later route;
- the live access surface differs from the bundled access manifest (section 3).

An application that throws at module load does not serve. On Zerops the container never becomes ready,
so the deploy fails and the previous version keeps serving.

### Canonical paths

The router answers 404 for any path that is not canonical (empty segments, `//`). Today it drops empty
segments (`packages/app/src/router.ts:46`) while the gate matcher reads the raw pathname, so
`/api//admin/users` reaches the `/api/admin/users` handler while the proxy evaluated only the rules for
`/api/*` and `/*`. The router and the proxy must see the same path.

## 2. Authentication is built in

```ts
export const app = defineApp({
	authenticate: (env) => createIam(env),
	routes: [...],
	rpc: notesRouter,
})
```

- The framework calls `authenticate` at most once per request, chosen by the matched endpoint's
  `caller`, never by path prefix. Applications stop writing auth middleware.
- IAM unavailable answers 503, never 401 (the existing three-state rule).
- A 401 carries no login URL. Login bounces stay with the proxy.
- **Zerops blocker.** `createIam` requires an `IamRpc` binding today, and a Zerops application has
  none, which is why `examples/zerops-app/src/authz.ts` verifies tokens with `jose` by hand. `createIam`
  must accept the JWKS over HTTPS from `FABRIKA_IAM_ISSUER` through `@fabrika/jwks`. That rewrites one
  invariant in `packages/auth/CLAUDE.md` ("createIam requires the binding everywhere").
- Lint refuses `jose` imports and reads of `X-Fabrika-Token` in application code.

## 3. The access manifest, and approval of widening

This is the mechanism for the person who reads nothing.

1. `fabrika app access` writes `fabrika.access.json` from the application's declarations. It is
   committed. A Markdown rendering (`fabrika.access.md`) is generated beside it for humans.
2. At startup the application compares its live surface with the bundled `fabrika.access.json` and
   refuses to boot on any difference. An application cannot run with an access surface other than the
   one in the file.
3. `fabrika app build` includes the file in the static manifest (ADR-0005). Control reads it as data and
   executes nothing.
4. Control compares it with the manifest of the last successful deploy of the same environment. A
   **widening** on a protected environment (production by default) holds the run until a principal with
   `deploy.approve-access` approves it. The prompt is written in plain language, for example:
   _"This deploy lets anyone on the internet call `notes.publicSubmit` without signing in."_

A widening is any of:

- a new endpoint with `caller: 'public'`, `'custom'` or `'share-link'`;
- a new or changed endpoint with `permission: { none }` or `{ member: true }`;
- an existing endpoint whose caller or permission becomes looser;
- `output: { raw }` on a new endpoint;
- a new `public` gate rule;
- a new connector consumer or a new `service` identity mode on an export (see the connectors idea).

The first production deploy of an application is all widening, so its whole surface is approved once.
An organization can give `deploy.approve-access` to someone other than the person who deploys.

Manifest columns: endpoint · method/path or procedure · caller · permission · scope source (data layer /
input / none) · output (schema / raw) · reason · gate kinds that reach it · flags.

## 4. Gates stay hand-written; a check keeps them consistent

`fabrika.gates.ts` stays the proxy's input, written by hand. Deriving gates from endpoint declarations
was considered and rejected:

- All RPC procedures share one path, so the weakest procedure would decide the gate for all of them.
- One `caller: 'public'` written by an agent would open both layers at once.
- The config build would need the application's runtime graph, which the gate files are isolated from
  on purpose.

Instead, `fabrika app build` (not a separate CI step, so it also runs for people with no CI) computes,
for each endpoint, which credential kinds can reach it, by running the `@fabrika/auth-core` matcher over
sample paths built from the declared patterns. Build-time tooling that runs the matcher over declared
patterns decides no request, so it is not a second gate evaluator; ADR-0022 needs one sentence saying
so.

| Severity | Condition                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------ |
| error    | a non-private endpoint that no gate rule matches                                                 |
| error    | a private endpoint that a gate rule matches                                                      |
| error    | the first matching gate is `public`, but the endpoint needs a token (it would always answer 401) |
| error    | a `public` gate rule matches an endpoint whose caller is not `'public'`                          |
| warning  | a `'public'` endpoint that every gate requires a credential for                                  |
| warning  | a gate rule that matches no endpoint and no asset                                                |

Gates only ever add access: an absent credential falls through to the next matching rule
(`packages/proxy-core/src/authorize.ts:167`). So "humans only" cannot be expressed as a gate in front of
a `service` rule; it is expressed as `caller: 'user'`. The comment at `packages/control/fabrika.gates.ts:17`
claims the opposite and should be corrected.

## 5. What the agent is told

The builder's decision catalog and agent skill carry the rules in a form an agent follows:

- Never use `caller: 'public'`, `'custom'`, `permission: { none }`, `output: { raw }` or
  `acknowledge: 'public-write'` without asking the human first, in plain words, what it exposes.
- When a request is refused with 401/403, do not loosen the declaration. Grant the permission in IAM
  or report the refusal.
- Run `fabrika app access` after any endpoint change and show the human the diff of `fabrika.access.md`.

These rules are cheap and unenforceable. The mechanisms in sections 1–4 do not depend on them.

## Migration

`@fabrika/app` and `@fabrika/auth` are published at 0.0.4. The change is breaking.

1. **Report only.** Add `describe()` over the current API and generate the access manifest for the
   examples, IAM, Control and Operations. That gives a baseline of how many endpoints have no
   declaration today.
2. **New definitions, plus a codemod.** Endpoints with `.require()` translate directly. Endpoints
   without one become `caller: 'custom', reason: 'migration: authorized in <use case>'` and
   `output: { raw: 'migration' }`, so nothing becomes more open.
3. **Built-in authentication.** Delete the hand-written middleware in the examples, the path-prefix
   logic in Control's auth middleware, and `examples/zerops-app/src/authz.ts`.
4. **Replace the migration escape hatches** one service at a time. A ratchet keeps their count from
   growing.
5. **Docs.** Rewrite ADR-0012 in place, add the sentence to ADR-0022, update
   `application-runtime.md` and `overview.md`.

## Alternatives considered

- **A builder chain with typestate** (`rpc.procedure.user().require(...).output(...).query(...)`), close
  to today's API. It works without casts, but its errors are indirect
  (`Property 'query' does not exist on type 'ProcedureNeedsAuthz'`), and a chain is harder to read as
  data. Kept as a fallback if the object form proves awkward to type.
- **Default-deny with a global guard and a `@Public()` opt-out** (NestJS style). Safe at runtime but does
  not narrow `ctx.auth`, and the opt-out is one short word.
- **Make `.require()` alone imply an authenticated caller.** Rejected: the caller kind is exactly what
  an inexperienced reviewer needs to see, and implying it hides threat 2.

## Open questions

- Should `{ member: true }` be the minimum for `'user'` callers, with `{ none }` allowed only for
  `'machine'`?
- Should `'custom'` require a `check` function, or may it defer entirely to the handler?
- Which environments are protected for widening approval: production only, or every environment
  marked `protected` in the registry?
- How should approval interact with a rollback to an older release whose surface was approved before?
- Hosts: Operations splits public ingest from private routes by `Host`. Neither the router nor the
  manifest knows about hosts yet.
- `audit()` has no transport for an application without an IAM binding (Zerops).
