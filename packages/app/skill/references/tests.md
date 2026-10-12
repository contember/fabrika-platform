# references/tests.md — generated tests, seeds and your own tests

## The generated tests

`bunx fabrika db test-scaffold` writes them from the contract and the table policies, and deletes the ones it no
longer writes. Commit them; never edit, format or import them (`generated-test-hash`).

- `src/db/__tests__/<table>.policy-isolation.test.ts`: the data layer keeps each table's rows in their scope.
- `src/__tests__/endpoint-access.test.ts`: every `on` and `in` endpoint refuses another scope's object (404 or 403);
  every `on` and `over` endpoint, and every `in` endpoint that declares `sql`, answers nothing of another scope; a
  caller with only an endpoint's write action reaches its own object (200).

Run them after every change of the contract or the tables. The platform runs them at every start, and the
application is not ready until each passes. A failing generated test is a bug in the handler, the policy or the
fixtures, never in the test: do not loosen access to make it pass.

## Fixtures and seeds

`src/__tests__/endpoint-access.fixtures.ts` is yours, read statically (plain literals only):

```ts src/__tests__/endpoint-access.fixtures.ts
export const seeds = { 'api.tasks.close': { status: 'doing' } }
```

- `export const fixtures = { '<endpoint id>': { … } }` is an input for an endpoint whose schema the scaffold cannot
  sample, such as a `regex` or a webhook's bind:
  `{ 'webhooks.github.bind': { scope: 'acme', account: 'installation:1' } }`. The checker names each missing one,
  and one of an endpoint that does not exist (`endpoint-fixture`). The access form's `from` field is
  replaced by the seeded scope.
- `seeds['<endpoint id>']` is the state its precondition needs, written into the row of the table that owns the
  endpoint's dimension in both scopes: `close` answers 409 for an open task, so the seed makes it `doing`. A seed
  sets neither a column that places the row nor a text column.
- The endpoint id is `<mount>.<group>.<endpoint>` (`api.tasks.close`).
- The seed of the tests fills every text column with a marker and every other required column with a sample of its
  type. A `CHECK` on a text column fails those rows: use an `ENUM` type. A required foreign key outside the
  containment chain cannot be filled: give it a default or make it nullable.

## Your own tests

Test the rules of `logic.ts` as plain functions. Test a handler through `testKit` and the typed client, with each
allowed call beside its refused twin:

```ts src/tasks/__tests__/tasks.test.ts
import { createClient, RpcError } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({
	migrations: new URL('../../../db/migrations/', import.meta.url),
	label: 'tasks.test.ts',
})

const statusOf = async (
	call: Promise<unknown>,
): Promise<number | undefined> => {
	try {
		await call
		return 200
	} catch (error) {
		return error instanceof RpcError ? error.httpStatus : undefined
	}
}

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const inAcme = (role: 'owner' | 'member') =>
		kit.testCaller([{ role, scope: { type: 'org', value: 'acme' } }])
	const owner = inAcme('owner')
	const member = inAcme('member')
	const ownerApi = createClient(contract, 'api', { fetch: kit.browser(owner) })
	const memberApi = createClient(contract, 'api', { fetch: kit.browser(member) })

	describe('tasks', () => {
		test('an owner assigns a task and a member may not; the assignee sees it under mine', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Launch',
			})
			const task = await memberApi.tasks.create({
				projectId: project.id,
				title: 'Write the brief',
			})
			expect(
				await statusOf(
					memberApi.tasks.assign({
						id: task.id,
						expectVersion: 1,
						assignee: member.id,
					}),
				),
			).toBe(403)
			expect(
				await ownerApi.tasks.assign({
					id: task.id,
					expectVersion: 1,
					assignee: member.id,
				}),
			).toEqual({ id: task.id, version: 2 })
			expect((await memberApi.tasks.mine({})).items.map((item) => item.id))
				.toEqual([task.id])
		})

		test('only a task in progress closes', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Ops',
			})
			const task = await memberApi.tasks.create({
				projectId: project.id,
				title: 'Rotate keys',
				dueOn: '2026-10-20',
			})
			expect(
				await statusOf(memberApi.tasks.close({ id: task.id, expectVersion: 1 })),
			).toBe(409)
			await memberApi.tasks.start({ id: task.id, expectVersion: 1 })
			expect(await memberApi.tasks.close({ id: task.id, expectVersion: 2 }))
				.toEqual({ id: task.id, version: 3 })
		})

		test('a caller of another org reaches nothing', async () => {
			const project = await ownerApi.projects.create({
				orgId: 'acme',
				name: 'Secret',
			})
			const outsider = createClient(contract, 'api', {
				fetch: kit.browser(
					kit.testCaller([{
						role: 'owner',
						scope: { type: 'org', value: 'other' },
					}]),
				),
			})
			expect(
				await statusOf(
					outsider.tasks.create({ projectId: project.id, title: 'Not mine' }),
				),
			).toBe(403)
			expect((await outsider.tasks.mine({})).items).toEqual([])
		})
	})
}
```

- `testDatabase` migrates a throwaway schema; without `FABRIKA_TEST_POSTGRES_URL` it answers `null` and the file
  registers no test. A skip proves nothing: run with the variable set.
- `kit.testCaller(grants, { kind })` makes a caller: a grant is a role or an action, in one scope or global. `kind:
  'machine'` presents a `px_` key (`createClient(contract, 'api', { fetch: kit.fetch, key: caller.key })`).
- `kit.runJob('<job>')` runs a cron job once and answers `{ status: 'succeeded', attempts }`.
- An application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to `testKit`.
- Run with `bun test --isolate`: the generated test boots the same application, and its data layer binds once per
  process. Import the test kits from test files only (`test-only-import`).
- No `.skip`, `.only` or test without an assertion, and no `mock.module` of `bun:test` or `@fabrika/*`.
