# references/start.md — a new application, before its first table

A new application starts without tables: a vocabulary, a contract, one endpoint and its first test. It needs no
database, no migration and no generated schema until it stores something. This file is an application of its own; its
`package.json` and `tsconfig.json` are those of `app-setup.md`, without the `build:web` script until it has an SPA.

## The files

```ts src/vocabulary.ts
import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'tasks',
	dimensions: {
		org: { members: { manage: 'members.manage', list: 'tasks.read' } },
	},
	actions: {
		'tasks.read': 'Read the tasks of an org',
		'members.manage': 'Invite and remove members',
	},
	roles: {
		owner: {
			grants: ['tasks.read', 'members.manage'],
			member: { scope: 'org', assignableBy: ['owner'] },
		},
	},
})
```

```ts src/app-kit.ts
import { defineApp } from '@fabrika/app/contract'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary)
```

```ts src/orgs/endpoints.ts
import { z } from 'zod/v4'
import { app } from '../app-kit'

const MyOrgs = z.strictObject({ all: z.boolean(), orgs: z.array(z.string()) })

export const orgs = app.group({ callers: ['human'] }, (r) => ({
	mine: r.query({
		output: MyOrgs,
		access: { action: 'tasks.read', over: 'org' },
	})
		.handle(({ ctx }) =>
			ctx.within.values === 'all'
				? { all: true, orgs: [] }
				: { all: false, orgs: [...ctx.within.values].sort() }
		),
}))
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { orgs } from './src/orgs/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { orgs }),
	health: c.health('/healthz'),
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'

export default serve(contract, { database: null })
```

- `defineApp(vocabulary)` declares no tables, so `serve` takes `database: null`, and only then. A handler has no
  `ctx.db`, `ctx.sql` or `unscoped` (a type error that names `defineApp(vocabulary, tables)`); it answers from the
  caller's grants (`ctx.within.values`, `ctx.principal`), the member directory, or a connector.
- Forms, jobs and file collections keep their rows in tables, so an application gets them with its first table.

```ts fabrika.config.ts
import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { defineApp, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'

const compiled = compileContract(contract, {})

const services = (): ZeropsServiceSpec[] => [
	{
		hostname: 'tasksapi',
		type: 'alpine/bun@1.3',
		priority: 10,
		enableSubdomainAccess: false,
		minContainers: 1,
		maxContainers: 2,
	},
]

export default defineApp({
	id: contract.vocabulary.app,
	schema: schemaFromContract(compiled),
	target: {
		platform: 'zerops',
		services,
		contract: compiled,
		proxy: { upstream: 'tasksapi:3000', ...contractProxyTable(compiled) },
		deployService: 'tasksapi',
		zeropsSetup: 'tasksapi',
	},
})
```

Without a PostgreSQL service the platform runs no `fabrika db migrate`, no codegen check and no generated test at
start. `zerops.yaml` holds only `build.base` until the application has an SPA to build.

## The first test

`bunx fabrika db test-scaffold` writes nothing for this application and says so: the generated tests start with the
first table (its policy test, then the endpoint access test over its rows). `bun test` fails on an application with no test file, and the platform's
build runs it, so write the first test yourself:

```ts src/__tests__/orgs.test.ts
import { createClient } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'

const kit = testKit(app)

describe('a new application', () => {
	test('answers its health check', async () => {
		expect((await kit.fetch('/healthz')).status).toBe(200)
	})

	test('lists the orgs a member works in, and refuses a caller of none', async () => {
		const owner = kit.testCaller([
			{ role: 'owner', scope: { type: 'org', value: 'acme' } },
		])
		const api = createClient(contract, 'api', { fetch: kit.browser(owner) })
		expect(await api.orgs.mine()).toEqual({ all: false, orgs: ['acme'] })
		const stranger = kit.browser(kit.testCaller([]))
		const refused = await stranger('/api/orgs.mine', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(refused.status).toBe(403)
	})
})
```

The loop of `SKILL.md` without its database lines: `bunx tsc --noEmit`, `bunx fabrika-check .`, `bun test --isolate`.

## The first table

When the application first stores something, in this order:

1. Add the PostgreSQL service to `fabrika.config.ts` (`app-setup.md`). The platform then migrates at every start.
2. `bunx fabrika db new <slug>` and the table's SQL (`table-and-migration.md`), then `bunx fabrika db migrate` and
   `bunx fabrika db codegen`, which writes `src/db/schema.generated.ts`.
3. `src/db/tables.ts` with the table's policy, over the generated `columns`.
4. `defineApp(vocabulary, tables)` in `src/app-kit.ts`, `serve(contract, { database: scoped(tables) })` in
   `src/app.ts`, and `compileContract(contract, tables)` in `fabrika.config.ts`.
5. `bunx fabrika db test-scaffold`: it now writes the generated tests. Commit them.

## The skill itself

These rules ship in `@fabrika/app` (`node_modules/@fabrika/app/skill/`), at the version the application installed:
read them there, or install them where an agent looks for skills.

- `bunx fabrika builder init --profile zerops-app --no-daemon --no-open --agent=claude` (or `codex`, or `all`)
  writes them under `.claude/skills/fabrika-app/` (`.agents/skills/fabrika-app/` for Codex) from the application's own
  `@fabrika/app`, beside the builder's `fabrika` skill. It also creates the builder's `.fabrika/` and an empty
  `tests/`. Run `bun install` first, or it installs the builder's copy and says so.
- After you update `@fabrika/app`, run it again: it replaces the files it installed and keeps a file you edited.
- An agent that reads `AGENTS.md` gets the same text, rendered by `renderAgentsFile` of `@fabrika/app/agent-skill`:
  `bun -e "import { installedAppAgentSkill, renderAgentsFile } from '@fabrika/app/agent-skill'; const skill =
  installedAppAgentSkill('.'); if (skill) await Bun.write('AGENTS.md', renderAgentsFile(skill))"`. Regenerate it
  after each update; never edit it.
