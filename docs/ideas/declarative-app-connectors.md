# Declarative application connectors

An organization runs several Fabrika applications, each owning part of the data — a product catalog, a shop, a
CRM. This proposal gives them a declarative, typed way to read each other's data. It shares the goal of
[secure-by-default application runtime](secure-by-default-app-runtime.md): an agent steered by an inexperienced
person must not be able to open one application's data to another application beyond what the owner exported
and a human approved.

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
- Each procedure is served at its own path, `POST /__fabrika/connect/products.v1.get`, with
  `callers: ['app:shop']`. The proxy enforces callers per procedure path, so the consumer's connector credential
  opens **these procedures and nothing else**. Threat 2 is closed at the proxy.
- **v1 exports are app-wide.** The consumer's credential holds the owner's action with no scope, so `over:
  'catalog'` gives the export every catalog the owner has. The approval prompt says so. Exports limited to chosen
  scopes need a way to name those scopes per edge and are a later phase.

## The consumer imports them

```bash
fabrika connect add catalog/products@1   # writes fabrika/connect/catalog.products.v1.ts (types, schemas, digest)
```

```ts
// shop's contract
imports: {
	catalog: catalogProductsV1.use({
		procedures: ['get', 'list'],
		usedBy: ['api.products.show', 'api.products.search'], // only these endpoints may call it
		timeoutMs: 3000,
	}),
},

// in a shop handler — the shop endpoint's own access was checked first
const product = await ctx.connect.catalog.get({ sku: input.sku })
```

- **`usedBy` binds the connector to named consumer endpoints** (threat 6). `ctx.connect.catalog` exists only in
  their handlers; a job, a webhook or another endpoint does not see it.
- The vendored snapshot is committed, readable by an agent, and carries the export's digest.

## Identity

- Each import has its own **connector credential** for the environment, narrowed to the imported procedures'
  actions at the owner. It is the one workload credential whose audience is another application (the owner); the
  proxy accepts it only on the export's procedure paths.
- **An edge** is `(shop, prod) → (catalog, prod, products@1)`. Control computes it from the two approved revisions;
  IAM creates the grant with source `connector:<edge>`. The grant write must be idempotent first (backlog 82).
- **No direct dial.** The owner application accepts a request only with the proxy's per-application secret
  (core proposal, section 2), so a consumer that dials the owner's service directly — even with a valid token — is
  refused.

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
- Zerops: a cheap namespace needs the per-application Postgres role (core proposal, section 8); without it a
  connector is theatre, because the consumer can read the owner's tables directly.

## Contract safety

- Control keeps the deployed exports and imports per environment, with digests.
- A **consumer deploy** is refused when the owner environment does not export `name@version` to it, or when the
  vendored snapshot is incompatible ("run `fabrika connect pull`").
- An **owner deploy** is refused when it removes a version or procedure a deployed consumer imports, or makes a
  breaking change inside a version ("bump `version`"). Breaking: a new required input field, a narrowed input type,
  a removed output field, a type change. Safe: a new optional input field.
- `fabrika connect graph --env=prod` prints the dependency graph.

## Failure behaviour

- Typed outcomes: `ok | denied | invalid_input | unavailable | timeout | contract_violation`. `unavailable` is never
  reported as `denied`.
- A deadline on every call: 3 s by default, 10 s at most.
- At most two retries on `unavailable` or `timeout`, inside the deadline. Queries are safe to retry.

## Approval

| Change                                                | Class    |
| ----------------------------------------------------- | -------- |
| A new export consumer, or a new import edge           | widening |
| A procedure added to an export, or a new output field | widening |
| An exported procedure's action or scope changes       | widening |
| A new `usedBy` endpoint in the consumer               | widening |
| A new version alongside the old one, same procedures  | additive |

## Later phases

- **Mutations** with idempotency keys and stored responses.
- **On behalf of the user.** The consumer exchanges the user's token for one at the owner (the shape of RFC 8693),
  with the user's permissions at the owner intersected with the edge. It needs a new credential path at the proxy
  and changes ADR-0022's invariant that IAM signs only from a session or a `px_` credential.
- **Change feeds** the consumer polls from a job into its own read model.

## What not to build

A query planner or federation router, cross-application joins, a central permission engine, shared databases as
connectors, a message broker, connectors across installations or environments.

## Three levels

- **Platform:** exports and imports in the approved revisions; per-procedure proxy paths with `app:<id>` callers;
  a narrowed connector credential per import; the proxy secret against direct dials; environment pairing;
  compatibility checks.
- **In-process framework:** `ctx.connect` only in `usedBy` handlers; typed outcomes; deadlines and retries.
- **Lint:** no `fetch` to another application's origin; no stored `px_` key used as a bearer.
- **Agent skill:** "to use another application's data, import its export"; if the export does not exist, ask the
  owner application's maintainer; never import per-user data in service mode.

## Open questions

- Does a Cloudflare service-binding `fetch` to the owner's proxy Worker route correctly when its URL carries the
  owner's host?
- Does the Zerops balancer forward `Authorization` unchanged across namespaces?
- Quotas or rate limits per edge.
