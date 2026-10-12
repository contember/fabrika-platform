# references/webhooks-links-connectors.md — webhooks, share links and connectors

Each of these lets someone in who is not a signed-in member of the scope. Ask the human before you add one, and say
what it lets that caller do.

## Webhooks (GitHub)

```ts src/github/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const RepositoryEvent = z.strictObject({
	action: z.string(),
	repository: z.strictObject({ full_name: z.string().max(200) }),
})

/** A repository created in the bound GitHub account becomes a project of the org the binding is for. */
export const github = app.webhook('/hooks/github', {
	scheme: 'github-sha256',
	boundTo: 'org',
	actions: ['tasks.write'],
	input: RepositoryEvent,
})
	.handle(async ({ input, ctx }) => {
		if (input.action !== 'created') return
		await ctx.db.in(ctx.refs['tasks.write']).projects.insert({
			name: input.repository.full_name,
		})
	})
```

- Mount it by name in the contract: `github,` beside `api`. It answers `POST /hooks/github/:bindingId`.
- `boundTo` is a dimension with `members`. A holder of its `members.manage` binds an org to a GitHub account with the
  generated `POST /api/webhooks.github.bind` (`{ scope, account: 'installation:<id>' | 'repository:<id>' }`), which
  answers the secret and the URL once. The generated tests need a fixture for it (`references/tests.md`).
- The framework checks the signature, the account and the input (undeclared fields are dropped), and runs a delivery
  at most once per body. `ctx.refs['<action>']` is a `Ref` of the bound org for each declared action.
- A delivery runs in one transaction. A handler that throws commits nothing and runs again on GitHub's redelivery, so
  an external effect after the data work keys its idempotency on `ctx.delivery.key`.

## Share links

```ts src/sharing/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { TaskStatus } from '../schemas'

const ShareTask = z.strictObject({ id: z.uuid(), days: z.int().min(1).max(30) })
const Shared = z.strictObject({ url: z.string() })
const SharedTask = z.strictObject({ title: z.string(), status: TaskStatus })

export const sharing = app.group({ callers: ['human'] }, (r) => ({
	share: r.mutation({
		input: ShareTask,
		output: Shared,
		access: { action: 'tasks.write', on: 'task', from: 'id' },
		issues: 'shared',
	})
		.handle(async ({ input, ctx }) => ({
			url:
				(await ctx.links.issue(ctx.target, { mount: 'shared', days: input.days }))
					.url,
		})),
}))

export const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'task',
	grants: ['tasks.read'],
	issuedBy: 'tasks.write',
	maxDays: 30,
	procedures: (l) => ({
		task: l.query({ output: SharedTask, access: { action: 'tasks.read' } })
			.handle(async ({ ctx }) => {
				const task = await ctx.db.target.get()
				return { title: task.title, status: task.status }
			}),
	}),
})
```

- Mount both: `api: c.rpc('/api', { …, sharing })` and `shared,`. The link's procedures are `POST /s/api/<name>` and
  its SPA is served under `/s/`.
- The issuing endpoint declares `issues: '<mount>'` and its action is the mount's `issuedBy`. IAM binds the key to the
  task's whole chain; the answer is `<prefix>/#<key>`, and a moved task's key reaches nothing.
- The share SPA reads the key with `shareKey()` of `@fabrika/app/client` and calls
  `createClient(contract, 'shared', { key })`. Never read `location.hash`.
- Issue the link after the data work: IAM does not roll back with the transaction.

## Connectors: another application's data

A consumer imports an owner's export. `bunx fabrika connect add catalog/products@1 --consumer=tasks --env=prod`
vendors the snapshot into `fabrika/connect/` (generated; `fabrika connect pull` refreshes it). The kit takes it, and
an endpoint that calls it declares `connect`:

```ts src/app-kit.ts
import { defineApp } from '@fabrika/app/contract'
import { catalogProductsV1 } from '../fabrika/connect/catalog.products.v1'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary, tables, {
	imports: { catalog: { snapshot: catalogProductsV1, procedures: ['get'] } },
})
```

```ts src/products/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const BySku = z.strictObject({
	orgId: z.string().min(1).max(100),
	sku: z.string().min(1).max(64),
})
const ProductName = z.strictObject({ name: z.nullable(z.string()) })

export const products = app.group({ callers: ['human'] }, (r) => ({
	name: r.query({
		input: BySku,
		output: ProductName,
		access: { action: 'tasks.read', in: 'org', from: 'orgId' },
		connect: ['catalog'],
	})
		.handle(async ({ input, ctx }) => {
			const product = await ctx.connect.catalog.get({ sku: input.sku })
			return {
				name: product.outcome === 'ok' ? (product.value?.name ?? null) : null,
			}
		}),
}))
```

- A call never throws for the owner's answer: it resolves to an outcome, `ok`, `denied`, `invalid_input`,
  `unavailable`, `timeout` or `contract_violation`. Handle every one besides `ok`.
- Exports are read-only and carry no per-user data. When the export you need does not exist, ask the owner
  application's maintainer. The platform writes `FABRIKA_CONNECT_*`; never read or set them.

The owner side is an export, mounted under `exports` in the contract. Its procedures run read-only for the consumer
applications it names:

```ts src/billing/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const ProjectCount = z.strictObject({ projects: z.int() })

export const projectCounts = app.export({
	version: 1,
	consumers: ['billing'],
	audience: 'any consumer user',
	procedures: (e) => ({
		count: e.query({
			output: ProjectCount,
			access: { action: 'tasks.read', over: 'org' },
		})
			.handle(async ({ ctx }) => ({
				projects: await ctx.db.within.projects.count(),
			})),
	}),
})
```

Change a published export only by adding to it (a new procedure, a new optional input field) or by a new version
served beside the old one.
