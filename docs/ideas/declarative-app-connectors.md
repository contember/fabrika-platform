# Declarative application connectors

An organization runs several Fabrika applications, each owning part of the data — a product catalog, a shop, a
CRM. This proposal gives them a declarative, typed way to read each other's data. It is part of the
[opinionated application framework](opinionated-app-framework.md): an agent steered by an inexperienced person must
not be able to open one application's data to another application beyond what the owner exported.

v1 is **read-only**: exports contain queries only.

## What exists today

- **One application can call another by hand.** An operator provisions a service principal with a `px_` key; the
  consumer stores it as a secret and calls the owner's public origin. There is no declaration, typed client,
  environment pairing or contract check. This is what an agent writes today when asked to "show catalog products
  in the shop".
- **Cloudflare allows a proxy bypass:** an application can bind directly to another application's private Worker
  (`packages/provider-cloudflare/src/plan.ts:240` refuses only platform names).
- **Zerops allows a direct dial and a shared database inside a cheap namespace** (ADR-0014): one project network,
  one Postgres credential.
- **IAM has no environment dimension:** a key or grant made on staging also works on production.

## Threats

1. **An over-permissive export** — "allow every application" to make an integration work.
2. **A consumer reaches more than the export** — a grant of actions also opens every other owner endpoint those
   actions satisfy.
3. **Bypassing the owner's proxy** — a direct binding, a direct dial with a token minted for the owner, or reading
   the owner's tables through a shared database credential.
4. **Cross-environment calls** — staging reaching production data.
5. **Confused deputy** — the consumer calls with its own identity and shows the result to any of its users.
6. **The consumer's power leaks into unrelated code** — a read-only endpoint, a job or a webhook of the consumer
   uses the connector.
7. **Silent contract drift** — the owner changes a field and the consumer misreads it.

## The owner exports queries

```ts
exports: {
	products: c.export({
		version: 1, // a breaking change is version 2, served alongside version 1
		consumers: ['shop'], // named applications; there is no wildcard
		audience: 'any consumer user', // see "Confused deputy"
		procedures: {
			get: c.query({ input: BySku, output: Product.nullable(), access: { action: 'catalog.product.read', over: 'catalog' } }),
			list: c.query({ input: Page, output: ProductPage, access: { action: 'catalog.product.read', over: 'catalog' } }),
		},
	}),
},
```

- Exports contain `c.query` only. A mutation in an export does not type-check in v1.
- **Read-only is enforced, not declared.** An export handler runs in a read-only context: the data layer exposes
  no write operation, the database transaction is `READ ONLY`, and the file and membership APIs are absent. A "get
  or create" behind `c.query` fails at runtime, so retrying a query is safe.
- Each procedure is served at its own path, `POST /__fabrika/connect/products.v1.get`. Because every procedure has
  its own path, the caller check applies per procedure: the consumer's credential opens **these procedures and
  nothing else**, which closes threat 2.
- **v1 exports are app-wide.** The consumer's credential holds the owner's action with no scope, so `over:
  'catalog'` gives the export every catalog the owner has. Exports limited to chosen scopes need a way to name those
  scopes per edge and are a later phase.

## The consumer imports them

```bash
fabrika connect add catalog/products@1   # writes fabrika/connect/catalog.products.v1.ts (types, schemas, digest)
```

```ts
// shop's contract
imports: {
	catalog: {
		app: 'catalog',
		export: 'products',
		version: 1,
		digest: catalogProductsV1Digest, // a const of the vendored snapshot
		procedures: ['get', 'list'],
		usedBy: ['api.products.show', 'api.products.search'], // only these endpoints may call it
		timeoutMs: 3000,
	},
},

// in a shop handler — the shop endpoint's own access was checked first
const product = await ctx.connect.catalog.get({ sku: input.sku })
```

- **`usedBy` binds the connector to named consumer endpoints** (threat 6). `ctx.connect.catalog` exists only in
  their handlers; a job, a webhook or another endpoint does not see it.
- The vendored snapshot is committed, readable by an agent, and carries the export's digest.

## Identity

**Part A, on today's platform.**

- An operator provisions one service principal per edge, with a `px_` key bound to the consumer's environment and
  narrowed to the imported procedures' actions at the owner. The consumer receives it under a framework-only
  variable; the framework sends it as the bearer, and application code never reads it.
- The owner's contract compiles each export path into today's gates as a `service` gate, so the proxy accepts the
  key only there.

**Part B, with [platform enforcement](platform-enforcement.md).**

- **An edge** is `(shop, prod) → (catalog, prod, products@1)`. Control computes it from the two approved contracts;
  IAM creates a connector credential of principal kind `app`, audience `catalog@prod`, with source
  `connector:<edge>`. Grant writes must be idempotent first (backlog 82).
- The proxy accepts it only for callers `app:shop` on the export's procedure paths.
- **No direct dial.** The owner accepts a request only with the proxy's per-application secret, so a consumer that
  dials the owner's service directly — even with a valid token — is refused.

**The cheap namespace is one trust boundary.** Applications in one cheap Zerops namespace share the Postgres
credential, so a consumer there can read the owner's tables directly. Connectors are the only path between two
applications only when they live in different namespaces, or in exclusive namespaces.

## Confused deputy

In service mode the owner cannot see which of the consumer's users the data is for; the consumer decides.

- This is right for data meant for everyone who uses the consumer (a product catalog), and wrong for per-user data
  (a CRM's contacts).
- An export states `audience: 'any consumer user'`, and the approval prompt says it: _"Everyone who can use `shop`
  will see catalog products through it."_
- Per-user data waits for the on-behalf-of phase; the agent skill says so.

## Wiring per provider

|                     | Cloudflare                                                       | Zerops, same namespace                      | Zerops, another namespace                                    |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Path                | a platform-generated service binding to the owner's proxy Worker | `http://proxy:8080` with the owner's `Host` | `https://<owner domain>`                                     |
| Environment pairing | the provider's per-environment naming                            | a namespace holds one environment           | Control resolves the owner's domain for the same environment |

- Control injects the address and refuses a deploy when the owner has no environment of the same name.
- Cloudflare: authored bindings to another application's Worker or data resources are refused.

## Contract safety

- Part A: the owner's framework serves each export's description (schemas and digest) on a generated path behind
  the same gate; `fabrika connect pull` fetches it with the consumer's key into the vendored snapshot. At runtime the
  consumer validates every response against the vendored output schema and reports `contract_violation` on a
  mismatch, so drift is caught on the first call, not at deploy.
- Part B: Control keeps the deployed exports and imports per environment, with digests.
  - A **consumer deploy** is refused when the owner environment does not export `name@version` to it, or when the
    vendored snapshot is incompatible ("run `fabrika connect pull`").
  - An **owner deploy** is refused when it removes a version or procedure a deployed consumer imports, or makes a
    breaking change inside a version ("bump `version`"). Breaking: a new required input field, a narrowed input
    type, a removed output field, a type change. Safe: a new optional input field.
  - `fabrika connect graph --env=prod` prints the dependency graph.

## Failure behaviour

- Typed outcomes: `ok | denied | invalid_input | unavailable | timeout | contract_violation`. `unavailable` is never
  reported as `denied`.
- A deadline on every call: 3 s by default, 10 s at most.
- At most two retries on `unavailable` or `timeout`, inside the deadline. Queries are safe to retry.

## Changes that wait for approval

With platform enforcement, these changes wait for a human on a protected environment:

| Change                                                | Waits on a protected environment |
| ----------------------------------------------------- | -------------------------------- |
| A new export consumer, or a new import edge           | yes                              |
| A procedure added to an export, or a new output field | yes                              |
| An exported procedure's action or scope changes       | yes                              |
| A new `usedBy` endpoint in the consumer               | yes                              |
| A new version alongside the old one                   | yes                              |
| A consumer, procedure or field removed                | no                               |

## Later phases

- **Mutations** with idempotency keys and stored responses.
- **On behalf of the user.** The consumer exchanges the user's token for one at the owner (the shape of RFC 8693),
  with the user's permissions at the owner intersected with the edge. It needs a new credential path at the proxy
  and changes ADR-0022's invariant that IAM signs only from a session or a `px_` credential.
- **Change feeds** the consumer polls from a job into its own read model.

## What not to build

A query planner or federation router, cross-application joins, a central permission engine, shared databases as
connectors, a message broker, connectors across installations or environments.

## Framework (part A)

What the framework gives on today's platform:

- typed exports and imports; the vendored snapshot with its digest; `ctx.connect` only in `usedBy` handlers; the
  read-only context with a `READ ONLY` transaction; typed outcomes, deadlines and retries;
- export paths compiled into `service` gates; an operator-provisioned `px_` key per edge, held by the framework;
- the checker: no `fetch` to another application's origin; no stored `px_` key used as a bearer by application
  code;
- the agent skill: "to use another application's data, import its export"; if the export does not exist, ask the
  owner application's maintainer; never import per-user data in service mode.

## Platform enforcement (part B)

What [platform enforcement](platform-enforcement.md) adds:

- edges computed by Control from both approved contracts, and connector credentials of principal kind `app`;
- per-procedure proxy paths with `app:<id>` callers;
- the proxy secret against direct dials; environment pairing; compatibility checks on both sides;
- connector changes wait for approval on protected environments.

## Open questions

- Does a Cloudflare service-binding `fetch` to the owner's proxy Worker route correctly when its URL carries the
  owner's host?
- Does the Zerops balancer forward `Authorization` unchanged across namespaces?
- Quotas or rate limits per edge.
