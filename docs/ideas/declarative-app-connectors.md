# Declarative application connectors

An organization runs several Fabrika applications, each owning part of the data — a product catalog, a
shop, a CRM. This proposal gives them a declarative way to expose data and to consume each other's data.
It shares the goal of [secure-by-default application runtime](secure-by-default-app-runtime.md): an agent
steered by an inexperienced person must not be able to open one application's data to another
application, or to that application's users, beyond what the owner allowed.

## What exists today

- **One application can call another by hand.** An operator provisions a service principal with a `px_`
  key (`packages/iam/src/admin/api-keys.ts`). The consumer stores it as a secret and calls the owner's
  public origin with `Authorization: Bearer px_…`. The owner's `service` gate exchanges it through
  `mintFromKey`. There is no declaration, typed client, environment pairing or contract check, and no
  way to act on behalf of a user.
- **Cloudflare allows a proxy bypass.** The authored-graph check refuses a `ServiceReference` only to
  platform service names (`packages/provider-cloudflare/src/plan.ts:239`), so an application can bind
  directly to another application's private Worker and skip its proxy.
- **Zerops allows a direct dial inside a namespace.** Applications in one cheap or mid namespace share
  the project network ([ADR-0014](../decisions/0014-provider-owned-deployment-namespaces.md) accepts this
  trust domain). Across namespaces only public access works.
- **IAM has no environment dimension.** `grants` has no environment column and a token's `aud` is the
  bare application id, so a role granted for an application holds in all of its environments. Whether a
  token minted for one environment verifies in another has not been tested.

## Threat model for connectors

1. **A consumer reads more than its users may see.** The consumer calls the owner with its own service
   identity and shows the result to any of its users — a confused deputy. The owner's per-object
   authorization never sees the real user.
2. **An over-permissive export.** An agent writes "allow every application" to make an integration work.
3. **A bypass of the owner's proxy** through a direct binding or a direct network dial.
4. **Cross-environment calls.** A staging consumer reaches production data.
5. **Silent contract drift.** The owner changes or removes a field, the consumer misreads it, and an
   authorization decision in the consumer uses a wrong value.

## Modes and phasing

| Phase         | Mode                                                                                                          | Why                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **v1**        | Live typed RPC to the owner, through the owner's proxy. Queries, plus mutations marked `idempotent`.          | Reuses `@fabrika/app` RPC, the `service` gate, `mintFromKey` and passthrough-JWT verification. No new infrastructure. |
| v2            | Pull feed: an export of kind `changes(cursor, limit)`. The consumer runs a cron and keeps its own read model. | Both providers have cron; no broker. Owner down means lag, not outage.                                                |
| v3, on demand | Push events: an owner outbox plus delivery to the consumer's `service` gate.                                  | Needs per-consumer delivery state, retries and dead-lettering. Wait for a latency need.                               |

## Declarations

The owner declares an export in a new file `fabrika.exports.ts`, imported by both `fabrika.config.ts`
and the server.

```ts
import { defineExport, mutation, query } from '@fabrika/app/connect'

export const products = defineExport({
	name: 'products',
	version: 1, // a breaking change is version 2, deployed alongside version 1
	consumers: {
		shop: { modes: ['user'] },
		crm: {
			modes: ['user', 'service'],
			serviceReason: 'nightly price sync, no user present',
		},
	},
	procedures: {
		get: query({
			input: GetProduct,
			output: Product.nullable(),
			permission: { action: 'catalog.product.read' },
		}),
		reserve: mutation({
			input: ReserveStock,
			output: Reservation,
			permission: { action: 'catalog.stock.reserve' },
			idempotent: true,
		}),
	},
})
```

- `consumers` names applications explicitly. There is no wildcard; it is not expressible in the type.
- **`user` mode is the default and the only mode that needs no reason.** In `user` mode the owner sees
  the real user and authorizes them per object, which closes threat 1.
- **`service` mode requires `serviceReason`** and counts as a widening (see below). In `service` mode the
  consumer decides which of its users see the data, and the owner must accept that consequence.
- The owner implements the export with the same endpoint definitions as any other procedure; `caller`
  and `permission` come from the declaration, so the owner cannot forget object-level authorization.
  Owner-side data access goes through [scoped database access](scoped-database-access.md) as usual.

```ts
// catalog: mounted at /__fabrika/connect/products/v1
const productsV1 = implementExport(products, {
	get: ({ ctx, input }) => ctx.db.table('products').getOrNull(input.sku),
	reserve: ({ ctx, input }) => stock.reserve(ctx, input), // runs once per Idempotency-Key
})
```

The consumer imports a vendored contract snapshot and declares what it uses:

```bash
fabrika connect add catalog/products@1   # writes fabrika/connect/catalog.products.v1.ts (types, JSON Schema, digest)
```

```ts
// shop/fabrika.config.ts
imports: {
	catalog: catalogProductsV1.use({
		modes: ['user'],
		procedures: ['get', 'reserve'],
		timeoutMs: 3000,
	})
}

// shop handler
const product = await ctx.connect.catalog.asUser().get({ sku: input.sku })
const { reservationId } = await ctx.connect.catalog.asUser().reserve(input, {
	idempotencyKey: input.orderId,
})
```

- `asService()` exists only when the import and the export both allow `service` mode.
- `asUser()` is unavailable in a handler with no user (`caller: 'machine'`, cron, jobs). A job cannot act
  as a user.

The static manifest ([ADR-0005](../decisions/0005-compile-app-config-to-static-manifest.md)) gains
`exports[]` and `imports[]`. Schemas travel as JSON Schema produced through
[Standard JSON Schema](https://standardschema.dev/json-schema); the build refuses a validator without
it.

## Identity and authorization

- **Workload principal per application environment.** Control creates a service principal
  `workload:<app>/<env>` when an environment is registered, with a principal-bound `px_` key delivered
  as a managed secret `FABRIKA_WORKLOAD_KEY`, and rotates it with an overlap period.
- **Edges.** An edge is `(shop, staging) → (catalog, staging, products@1, modes, actions)`. Control
  computes edges from the two manifests. An edge is active when the owner allows it and the consumer
  imports it. Control sends IAM only the authorization facts; IAM stores the edge and creates a grant
  with source `connector:<edgeId>`. Grants must be idempotent first
  ([backlog 82](../backlog/82-a-duplicate-cross-app-grant-answers-500.md)).
- **Service mode.** The consumer sends its workload key to the owner's proxy. The `service` gate mints a
  token with only the edge's actions, for the matching environment.
- **User mode** (the shape of [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html) token exchange, a
  new `IamRpc.exchangeToken`):
  - The consumer passes the token it received for its own audience as `subjectToken`, its workload key
    as actor, and the target audience.
  - IAM checks that the subject token's `aud` is the actor's application, that the environments match,
    and that the edge allows `user` mode.
  - Permissions are the user's live permissions at the owner **intersected** with the edge's actions.
    The consumer can never obtain more than the user holds at the owner.
  - The token lives at most 300 seconds and never outlives the subject token. A new claim
    `act: { sub, app }` names the consumer. The owner's audit records both identities.
- **Environment in identity.** The proxy manifest, the mint input, the token and the SDK verification
  gain an environment. That closes threat 4 for connectors and the untested replay question above.
- **ADR-0022 holds.** The proxy stays the only gate evaluator; the owner runs only authorization; the
  consumer evaluates nothing; IAM resolves policy at mint, as it does today. The provider prepends
  `{ path: '/__fabrika/connect/*', kind: 'service' }` to the owner's gates, and the build refuses a
  `public` rule that matches a connector path.

## Wiring per provider

|                     | Cloudflare                                                  | Zerops, same namespace                      | Zerops, another namespace                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Path                | a generated service binding to the owner's **proxy** Worker | `http://proxy:8080` with the owner's `Host` | `https://<owner domain>`                                     |
| Environment pairing | the provider's per-environment naming                       | a namespace holds one environment           | Control resolves the owner's domain for the same environment |

- Control injects the address. It refuses a deploy when the owner has no environment of the same name.
  Cross-environment connectors are not supported.
- **Close the Cloudflare bypass independently of connectors:** refuse an authored `ServiceReference` to
  another application's Worker.
- The Zerops direct dial cannot be refused at the network level. The generated client never uses it,
  and a direct dial carries no proxy-injected token, so every non-public endpoint of the owner answers
  401 (see `exposure: 'private'` in the runtime idea).
- Cloudflare binding `props` are not used as identity: the consumer's own configuration writes its
  bindings, so props would be self-asserted.

## Approval

A new edge is a **widening** in the sense of the runtime idea's access manifest. On a protected
environment, Control holds the deploy that activates it until an approver confirms, in plain language:
_"`shop` (production) will read `catalog` products on behalf of its signed-in users."_ A `service`-mode
edge shows its `serviceReason` and says that `shop` decides which of its users see the data.

## Contract safety

- Control keeps a registry of deployed exports and imports per environment, with digests.
- **Consumer deploy** is refused when the owner environment does not export `name@version`, when the
  consumer is not on the export's list, or when the vendored snapshot is incompatible with the deployed
  contract ("run `fabrika connect pull`").
- **Owner deploy** is refused when it removes a version or a procedure that a deployed consumer in that
  environment imports, or when it makes a breaking change inside a version ("bump `version`").
  - Breaking: a new required input field, a narrowed input type, a removed or newly optional output
    field, a widened output enum, a type change.
  - Safe: a new optional input field, a new output field.
  - Needs approval: a changed `permission`, `idempotent` switched off, a new `service` mode.
- **Order per environment:** the owner adds v2, consumers move, the owner drops v1.
- `fabrika connect graph --env=prod` prints the dependency graph; `fabrika connect describe
  catalog/products@1` prints a contract for a coding agent.

## Failure behavior

- Typed outcomes: `ok | denied | invalid_input | unavailable | timeout | contract_violation |
  unknown_outcome`. `unavailable` is never reported as `denied`.
- A deadline on every call: 5 seconds by default, 30 at most.
- Retries only on `unavailable` or `timeout`, only for queries and `idempotent` mutations, at most two,
  jittered, inside the deadline. Never on a 4xx.
- An `idempotent` mutation requires an `Idempotency-Key`. An owner-side helper stores
  `(actor, key) → (request digest, response)` for 24 hours; the same key with a different digest answers
  409.
- A non-idempotent mutation that times out returns `unknown_outcome` and is not retried.
- The owner validates output before sending; the consumer parses it at the boundary. A violation is
  reported to Operations tagged with the connector.

## What not to build

- A query planner, a federation router, cross-application joins, GraphQL or OData surfaces.
- A central permission engine, or a new gate kind for connectors.
- Shared databases as connectors. A cheap namespace's shared Postgres is a trust domain, not an API.
- A platform-managed replica in the consumer's database. The consumer owns its read model.
- A message broker, or exactly-once claims, in v1.
- Connectors across installations or across environments.

## Open questions

- Does a token minted for one environment verify in another today? A test against `TokenVerifier` and
  the proxy settles it.
- Does a Cloudflare service-binding `fetch` to the owner's proxy Worker route correctly when its URL
  carries the owner's host?
- Does the Zerops balancer forward `Authorization` and large bodies unchanged across namespaces?
- Quotas or rate limits per edge, and whether the owner sees which procedures each consumer calls.
- Cursor format and tombstones for v2 `changes` feeds.
