---
id: 0012
title: An application declares one contract and implements it with @fabrika/app
status: accepted
date: 2026-10-08
---

# 0012 — An application declares one contract and implements it with `@fabrika/app`

## Context

fabrika owns an application's deployment, identity model, authorization policy, proxy enforcement and
audit. `@fabrika/app` is its first-party server framework: typed RPC, `.require()`, the runtime adapters
and the contract runtime. It came from the separate Trasa project, which was absorbed so that the auth contracts
and the framework change in one repository.

Without one declaration, an application declares its access surface three times, by hand:

- a schema module holds the IAM vocabulary (actions, roles, scope dimensions);
- a rule list holds the proxy's path rules;
- the router holds the routes, the middleware and the `.require()` calls.

Nothing ties the three together. The likely mistakes, in order:

1. An endpoint with no authorization, or a check in one handler that is missing in the next.
2. Authenticated mistaken for authorized. IAM mints a token for every person who can sign in, with
   `perms: []` when the person has no grant in this application.
3. Object-level access (IDOR): the handler checks `notes.read`, then loads any note by id.
4. Identity or scope taken from the request body (`ownerId`, `workspaceId`).
5. A whole database row returned.
6. Code around the framework: a hand-written server, a database driver, raw SQL.

A coding agent makes these mistakes routinely, because it optimizes for "it works". The Zerops example
in this repository already bypasses the framework: it calls `Bun.serve`, opens `new SQL(...)` and
verifies tokens with `jose` (`examples/zerops-app/src/`).

Two matchers can also read paths differently. A router that drops empty segments selects by a
different path than a proxy that reads the raw path. The proxy can then decide for one rule while the
router serves a different handler.

Finally, the platform must be able to read the access surface without executing application code
([ADR-0005](0005-compile-app-config-to-static-manifest.md)). An application authored over MCP has no
local toolchain, so Control will have to read it from source. A declaration that only exists after
the application's module graph runs cannot serve that purpose.

## Decision

**We will make one contract the whole access surface of an application, and `implement` in
`@fabrika/app` the only way to serve it.**

### 1. The contract is the declaration

`fabrika.contract.ts` is a pure-data, browser-safe module. It is the only declaration of an
application's access surface; there is no separate schema module and no rule list. It declares:

- the authorization vocabulary: scope dimensions with containment, actions, roles that list exact
  actions, and the actions that manage and list membership;
- every mount with its callers (`human`, `machine`, `link`, `app:<id>`), once per mount;
- every endpoint with its access requirement and its input and output schemas;
- files, jobs, webhooks, exports and imports, as each of those companions lands.

Table policies live in `src/db/tables.ts`.

Rules of the contract:

- **The contract is a literal.** The contract, its schema modules and `src/db/tables.ts` contain only
  object and array literals, strings, numbers, booleans, the known `c.*` and `z.*` calls, and `const`
  imports of such values. No computed value and no call of the application's own functions. The
  checker (`@fabrika/check`) enforces this rule in the application's build.
- **Schemas are zod 4** (`zod/v4`), restricted to a serializable subset: strict objects, no
  transforms, no `passthrough`. Validation inside a handler stays library-neutral.
- **Nothing is open by omission.** Every endpoint of a credentialed mount declares `access`. There is
  no default, no `none` and no `public` caller. Every endpoint for a signed-in caller requires an
  action or membership in this application. Anonymous traffic exists only through fixed kinds
  (`c.health`, `c.form`, `c.webhook`, `c.link`).
- **One path per procedure.** A procedure is served at `POST <mount>/<procedure>`, for example
  `POST /api/notes.remove`. The `{ batch }` request form is removed.

### 2. Applications use `implement`, never raw routes or middleware

`implement(contract, { database, deps, handlers })` is type-checked against the contract. A handler
for an undeclared endpoint, a missing handler, or a handler of the wrong kind is a type error.

- There is no slot for middleware, raw routes, `authenticate`, a custom server or a WebSocket upgrade.
  An application cannot add surface that the contract does not declare.
- The entrypoint is generated (`fabrika app build` writes `fabrika/entry.generated.ts`). It calls
  `boot(app, { env, iam, origin })`, which reads the framework's variables, removes them from
  `process.env` and serves through the runtime adapters of
  [ADR-0013](0013-explicit-runtime-adapter-entrypoints.md).
- A handler receives authorized capabilities, not raw ids: `Ref<dim, action>` for one object and
  `Within<dim, action>` for the scopes where the caller holds the action. They are bound to their
  request and checked at runtime too, because TypeScript cannot prevent every widening.
- Errors map to 400, 403, 404 and 409 with one envelope.

The installation's own services (IAM, Control, Operations) do not use `defineContract`. Each declares
a **service contract** (`defineServiceContract` in `@fabrika/app/service`): one endpoint table per
service. `serveService` is its thin dispatcher over `planEndpoint`. The proxy reads such a table as an
installation entry, which platform composition marks and which may use five forms no application
contract can declare ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) "Installation
entries"), among them the `oauth` caller of MCP authoring.

### 3. The router and the proxy select from one endpoint table

The contract compiles to one endpoint table. The framework dispatches from it through `planEndpoint`
in `@fabrika/auth-core`, which refuses a non-canonical path and selects the most specific endpoint.
An unknown procedure under an RPC prefix is 404 and never falls through to the SPA.

The proxy selects from the same table. The router therefore cannot serve a path under different rules
than the proxy applied, and `X-Fabrika-Endpoint` names the endpoint and the digest of those rules.

### 4. The proxy reads the endpoint table; the contract generates the IAM schema

The contract compiles into the two artifacts the proxy and IAM consume:

- **`contractProxyTable(artifact)`** (`@fabrika/proxy-core/manifest`) produces the endpoint table of
  the proxy manifest: every row's rules, its delegation and digest, the reserved prefixes and the
  contract digest. The proxy decides per endpoint with it
  ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 3). The manifest parser refuses
  any other form of entry.
- **`schemaFromContract(contract)`** produces the `AppSchema` that the deploy reconciles into IAM:
  scopes with their membership metadata, actions, roles, link mounts, and the endpoints that spend
  membership authority (`creates`, and the dimension's `members.manage`) as delegations.

Both providers take these from `fabrika.config.ts`. The application never writes either by hand.

### 5. The framework authorizes; the proxy stays the only enforcement point

The vocabulary is the one of [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) and
[`overview.md`](../reference/overview.md). The proxy decides with the endpoint table and the canonical
matcher, and it is the only enforcement point. The framework makes no enforcement decision.

Per request, after the proxy has admitted it, the framework runs these steps in order:

1. Refuse a non-canonical path; select the endpoint with `planEndpoint`.
2. Verify the proxy-injected token with the shared verifier
   ([ADR-0040](0040-share-one-token-verifier.md)).
3. Check that the token's principal kind is one of the mount's callers.
4. Check the endpoint's requirement: `member` (any permission of this application), or the action in
   some scope.
5. For a session request that is not `GET`, require `Sec-Fetch-Site: same-origin`, and
   `Content-Type: application/json` for RPC.
6. Parse the input strictly, run the access form (`on`, `in`, `over`, `creates`), remove the `from`
   field, call the handler, and project the output through its schema.

The caller-kind check (step 3), the requirement check (step 4) and the access form (step 6) are
**authorization**. The same-origin and content-type check (step 5) is **admission**. Neither is a
second enforcement decision: neither selects whether a request reaches the service, and the proxy has
already made that decision.

The proxy checks the caller kind and the requirement too
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 3). The framework repeats them as
authorization.

### 6. Membership, scopes and share links come from IAM

The framework requests a new scope value, a membership change or a share link from IAM on the
caller's behalf, with the caller's token as proof. IAM evaluates each request against the caller's
live permissions, does the write and issues every key. The application supplies no actor, writes no
grant and mints no credential. IAM has these operations (`IamMembershipRpc`) and reads the membership
metadata from the application's schema: containment, the creator role, the members actions,
`assignableBy`, link mounts and the endpoints that may spend a delegation grant. An invitation by
email is accepted on IAM's own page by the principal that owns the invited mailbox, proven by the
one-time link IAM mails; without an email service there are no invitations.

### 7. Where the contract becomes binding

The framework runs inside the application process and the application's own build. An agent that
edits the contract, a role, `fabrika.config.ts`, the build commands or the checker's invocation can
loosen any of it, and only the pull request shows the change.

Other ADRs make the contract binding outside the application process:

- The proxy reads the endpoint table, and checks caller kinds, requirements and admission itself:
  [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md).
- Control reads the contract from source by static parsing
  ([ADR-0005](0005-compile-app-config-to-static-manifest.md)), and a widened contract waits for a human
  on a protected environment ([ADR-0050](0050-approved-access.md)).
- The platform owns the run section and the server build on Zerops
  ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)) and builds the proxy Worker
  on Cloudflare ([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)).
- The installation's own services declare service contracts, not `defineContract`, and their tables
  reach the proxy as installation entries
  ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)).

None of these is built yet; until they are, the framework is the only check.

## Consequences

- An application declares its access surface once. The proxy's endpoint table, the IAM vocabulary, the
  router, the typed client and the handler types derive from it.
- A missing access declaration is a type error and a path no endpoint serves. A forgotten endpoint
  stops being a silent hole.
- The router and the proxy select by one table, so a path cannot pass one endpoint's rules and reach a
  different handler.
- The literal rule makes contracts more verbose. Shared schema fragments must be `const` imports;
  computed contracts are impossible.
- Contracts depend on zod 4. Other validators cannot appear in a contract.
- `@fabrika/app` has two serving surfaces: `implement` for applications and `serveService` for the
  installation's own services. Both dispatch through `planEndpoint` and run on the same runtime
  adapters; a service's typed RPC mount uses the same RPC wire (`dispatchRpcRequest`).
- RPC clients can no longer send `{ batch }`. One request is one procedure.
- `@fabrika/auth-core` gains the contract model, `planEndpoint` and the requirement check. The proxy
  and the framework select with the same `planEndpoint`, and the per-endpoint digest proves they
  applied the same rules.
- Until platform enforcement exists, a loosened contract or role is visible only in review. The
  framework is a strong default, not a boundary against an agent that edits any file.

## Alternatives considered

- **Keep a separate schema module and rule list and add a consistency check.** Rejected: a check
  catches disagreement between the files, not a widening that keeps them consistent.
- **Code-first: mounts inside a router, the access surface extracted by importing the application.**
  Rejected: the build must execute the application's module graph, and the extracted data is the
  application's self-report.
- **File-based routing.** Rejected: per-endpoint requirements stay invisible outside the application,
  and URLs move with files.
- **Resource-first: tables with policies and generated CRUD.** Rejected as the base: strong for CRUD,
  with an expressiveness cliff for everything else. It remains a candidate for sugar on top of the
  contract.
- **Keep middleware and raw routes for applications next to the contract.** Rejected: any slot for
  raw surface is a path that the contract and the proxy's table do not describe.
- **A computed contract.** Rejected: the platform could read it only by executing application code.
- **Accept any Standard Schema validator in contracts.** Rejected: the contract must be readable
  without evaluation, which needs one known set of schema calls.
- **Keep `@trasa/core` independent and add a Fabrika integration package.** Rejected: the shared auth
  contracts and the framework are one product surface and must change together.
