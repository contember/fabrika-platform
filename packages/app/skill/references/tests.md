# references/tests.md — generated tests, seeds and your own tests

## The generated tests

`bunx fabrika db test-scaffold` writes them from the contract and the table policies, and deletes the ones it no
longer writes. Commit them; never edit, format or import them (`generated-test-hash`).

- `src/db/__tests__/<table>.policy-isolation.test.ts`: the data layer keeps each table's rows in their scope.
- `src/__tests__/endpoint-access.test.ts`: every `on` and `in` endpoint refuses another scope's object (404 or 403);
  every `on` and `over` endpoint, and every `in` endpoint that declares `sql`, answers nothing of another scope; a
  caller with only an endpoint's write action, plus what IAM requires of it (below), reaches its own object (200). An
  `app` or `creates` endpoint refuses a holder of its action in one scope only (403) and answers a global holder. An
  endpoint of several `capabilities` adds a denied case per capability. A public procedure answers anyone without a
  credential, or, behind a challenge, refuses a caller without a solved one. A file input is sent as a generated file
  of its kind; a `GET` procedure's input goes in its URL.
- Their kit stands in for IAM, as `testKit` does (below): it creates a scope, assigns or invites a member and issues a
  link under IAM's rules for the caller's grants. A repeated invitation answers the open one, `resend` restarts its
  7 days, and an organization's address is refused for an external role (`internal_mailbox`). So the caller of an endpoint with the dimension's `members.manage`
  holds it on the object itself, with one role the assigned role's `assignableBy` names and the assigned role's
  actions: the membership roles the input names, or every one of the dimension when it names none. The caller of an
  endpoint that `issues` also holds the actions its link grants.

Run them after every change of the contract or the tables. The platform runs them at every start, and the
application is not ready until each passes. A failing generated test is a bug in the handler, the policy or the
fixtures, never in the test: do not loosen access to make it pass. A case that throws instead of failing an
assertion names what the generator could not build: an input the schema refuses, an input the handler refused (400),
which the fixtures below supply, or a `SeedLimitError` of the seed (below). Do not reshape the contract or the schema
around one; ask the human.

## Fixtures and seeds

`src/__tests__/endpoint-access.fixtures.ts` is yours, read statically (plain literals only):

```ts src/__tests__/endpoint-access.fixtures.ts
export const seeds = { 'api.tasks.close': { status: 'doing' } }
export const members = { 'api.tasks.assign': ['assignee'] }
```

- `export const fixtures = { '<endpoint id>': { … } }` is an input for an endpoint whose schema the scaffold cannot
  sample, such as a `regex` (a webhook's account):
  `{ 'api.integrations.connectGithub': { orgId: 'acme', account: 'installation:1' } }`. The checker names each missing one,
  and one of an endpoint that does not exist (`endpoint-fixture`). The access form's `from` field is
  replaced by the seeded scope.
- `members['<endpoint id>']` lists the input fields that name a picked person the handler checks with
  `ctx.members.get` (`assign`'s `assignee`). The generated cases send a real member of the object's org there; without
  it they send a sample, the handler answers 400, and the case fails.
- `invitations['<endpoint id>']` and `links['<endpoint id>']` list the input fields that name an invitation an endpoint
  cancels (`ctx.members.revoke(ctx.target, { invitationId })`) or a share link it revokes (`ctx.links.revoke(id)`):
  `export const invitations = { 'api.members.cancel': ['invitationId'] }`. The generated cases send one their stand-in
  IAM holds there: an invitation open in the object's value, a link of the endpoint's mount that the case's caller
  issued. Without it they send a sample, IAM answers 404, and the case fails.
- `seeds['<endpoint id>']` is the state its precondition needs, written into the row of the table that owns the
  endpoint's dimension in both scopes: `close` answers 409 for an open task, so the seed makes it `doing`. A seed
  sets neither a column that places the row nor a text column that holds a marker; a text column a CHECK lists the
  values of, and a foreign key, it may set.
- `rows['<endpoint id>']` names the input fields that address a row lying in the endpoint's object, with that row's
  table: `export const rows = { 'api.tasks.editComment': { commentId: 'task_comments' } }`. The generated cases seed
  one row of the table in each scope's object and send its key there. The table lies directly in the object: a child
  table of the table that owns it, or a table it contains; the checker refuses a row further down
  (`endpoint-fixture`). Without it they send a sample, the handler
  finds no row (404), and the case fails.
- `appRows['<endpoint id>']` gives the rows of application tables (`scope: { app }`) that the endpoint's handler reads
  for the caller's own scope, by table, with the columns they need: `export const appRows = { 'portal.guide': { guides:
  { active: true } } }`. Each of its leak and own-object cases seeds one row of each before it asks and removes them
  once it is over, with every row that refers to them (a download the handler logged), so a handler that reads the
  newest guide answers 200 instead of 404, and no other endpoint's case finds the row. A foreign key from one given row
  to another holds that row's key. A text column may be given; the key, the version, the creator and a file column may
  not (a file column holds a live, scanned file). Only application tables, and only for an endpoint with a leak or an
  own-object case: the checker refuses a table in a scope, which `rows` and `seeds` address (`endpoint-fixture`).
- The endpoint id is `<mount>.<group>.<endpoint>` (`api.tasks.close`).
- The seed of the tests fills every text column with a marker and every other required column with a sample of its
  type: an enum's first label, `1`, `false`, today. A column with a `DEFAULT` keeps it (`status` is `open`). A column
  a `CHECK` names gets the first value of an `IN (…)` list, or `null` where it is nullable. A foreign key outside
  the containment chain is `null` where it is nullable, and otherwise references an existing or a seeded row of a
  reference or application table. What the seed cannot satisfy (another `CHECK` on a required text column, a required
  key to a dimension or child table outside the chain) fails the test with a `SeedLimitError` that names the
  constraint: a limit of the generator, not a bug of the handler. Keep the column as the domain needs it, and ask the
  human when the limit blocks the tests.
- A generated case's input is a sample of the schema: no optional field, `null` for a nullable one, an enum's first
  value, the shortest string its bounds admit (`'x'`), the smallest number, `false`, a fixed value for a format
  (`uuid`, `email`, `iso.date`). When that input meets a precondition (`close` of an `open` task is 409), seed the
  state, or give the whole input in `fixtures`.

## Your own tests

Test the rules of `logic.ts` as plain functions. Test a handler through `testKit` and the typed client, with each
allowed call beside its refused twin:

```ts src/tasks/__tests__/tasks.test.ts
import { createClient } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({
	migrations: new URL('../../../db/migrations/', import.meta.url),
	label: 'tasks.test.ts',
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const acme = kit.scope('org', 'acme')
	const inAcme = (role: 'owner' | 'member') =>
		kit.testCaller([{ role, scope: acme }])
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

		test("the member directory lists the org's members", async () => {
			const listed = await memberApi.members.list({ orgId: 'acme' })
			expect(listed.items.map((item) => item.principalId).sort()).toEqual(
				[owner.id, member.id].sort(),
			)
		})

		test('a member lists its orgs; a global grant lists none and says all', async () => {
			expect(await memberApi.members.orgs()).toEqual({
				all: false,
				orgs: ['acme'],
			})
			const auditor = createClient(contract, 'api', {
				fetch: kit.browser(kit.testCaller([{ action: 'tasks.read' }])),
			})
			expect(await auditor.members.orgs()).toEqual({ all: true, orgs: [] })
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

- `testDatabase` migrates a throwaway schema; without `FABRIKA_TEST_POSTGRES_URL` it answers `null`, prints
  `<label> skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests`, and the file registers no test.
  A skip proves nothing. To confirm a file ran, run it alone (`bun test --isolate src/tasks`) and check that the pass
  count is its number of tests, or set `FABRIKA_TEST_POSTGRES_REQUIRED=1`: a missing URL then fails the file.
- On Cloudflare import `testDatabase` from `@fabrika/db/testing-sqlite` instead, with the same options: it migrates a
  fresh in-memory SQLite database as the Durable Object does, needs no URL and never answers `null`. The generated tests
  already use it.
- `statusOf(call)` answers 200 when the call resolves and the status of the application's refusal otherwise; any other
  failure (no answer, a bug in the test) is rethrown. Import it beside `testKit`; do not write your own.
- `kit.testCaller(grants, { kind })` makes a caller: a grant is a role or an action, in one scope or global. A
  membership role is granted in one value of its scope; an action without `scope` is a global grant, for which
  `ctx.within.values` is `'all'` (`kit.testCaller([{ action: 'tasks.read' }])`). `kind: 'machine'` presents a `px_`
  key (`createClient(contract, 'api', { fetch: kit.fetch, key: caller.key })`).
- Build a scope you reuse with `kit.scope('org', 'acme')` (`acme` above). An object literal stored in a variable
  widens its `type` to `string`, which tsc refuses as a grant's `scope`; a dimension the contract lacks is a type error.
- A caller's `id` is `<kind>-<n>` and its `label` `<kind>-<n>@<app>.test`, `n` counting the kit's callers; pass
  `{ id, label }` to fix either (`kit.testCaller(grants, { label: 'Ann' })`). The label is a `string`, only a link
  holder's (`kind: 'link'`) is `null`; it is `ctx.principal.label`, and the directory's label where it shows labels.
  Assert a stored label against `caller.label` or the directory's answer (`members.list` above), never against a
  literal of the default form.
- A human's `email` is `ctx.principal.email`: `<kind>-<n>@<app>.test` unless you pass `{ email }`, which the kit
  lower-cases as IAM does (`kit.testCaller(grants, { email: 'Ann@Example.com' })` mails `ann@example.com`). A
  `machine`, `app` or `link` caller's `email` is `null`. The SPA's `<prefix>/__fabrika-me.json` answers the caller's
  label, email and actions in the kit as in production (`kit.browser(caller)('/__fabrika-me.json')`).
- `kit.browser(caller)` and `kit.fetch` serve one origin, `https://<app>.test` (`kit.origin`). Call a route by its
  path (`kit.browser(owner)('/api/tasks.get', { method: 'POST', … })`), never with another host.
- An SPA mount is served from its built `dir` (`dist/web`) when the build exists, as the deploy serves it:
  `kit.browser(owner)('/')` answers the built `index.html`, a file by its path, and every other path of the mount the
  `index.html` again. Without a build it is an empty page. The directory is relative to the working directory, the
  application root under `bun test`; pass `testKit(app, { root })` from elsewhere.
- The kit stands in for IAM's membership operations. A member directory (`ctx.members.list()` and `get(id)`) answers
  from the kit's own callers: everyone `testCaller` gave a membership role in that scope, labels only where the
  dimension declares `directory: 'labels'` (or to a `members.manage` holder). `kit.testCaller(grants, { lastSignInAt })`
  is a person who signed in then; a `members.manage` holder's `list(ref)` answers it, and `null` for everyone else. The
  application's own directory (`ctx.members.list()` of an `app: true` endpoint) lists every caller holding a role of the
  contract, by id. To list someone, make them a caller:
  `kit.testCaller([{ role: 'member', scope: { type: 'org', value: 'acme' } }])`. A `creates` endpoint, member
  management and share links answer under IAM's rules for the caller's grants, and a role they give or remove is live
  from the caller's next request, as in IAM: the creator of a value holds its creator role, a removed member is
  refused and no longer listed.
- `kit.acceptInvitation(invitationId)` is the invited person accepting an invitation your handler opened
  (`ctx.members.assign(ctx.target, { email }, role)`): it answers a new caller labelled by the address, holding the
  role in that scope (an `external` person for an external role). Pass a caller to make an existing person the
  member: `kit.acceptInvitation(invitationId, member)`. It throws as IAM refuses: an invitation that is not open, an
  external person and a role not declared external (`not_eligible`), an inviter that has since lost the authority to
  give the role (`not_allowed`).

```ts src/members/__tests__/members.test.ts
import { createClient } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

const postgres = await testDatabase({
	migrations: new URL('../../../db/migrations/', import.meta.url),
	label: 'members.test.ts',
})

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database })
	const owner = kit.testCaller([{
		role: 'owner',
		scope: kit.scope('org', 'acme'),
	}])
	const ownerApi = createClient(contract, 'api', { fetch: kit.browser(owner) })

	test('an invited person accepts and is listed; once removed, it is refused', async () => {
		const { invitationId } = await ownerApi.members.invite({
			orgId: 'acme',
			email: 'ann@example.test',
			role: 'member',
		})
		const ann = kit.acceptInvitation(invitationId)
		const annApi = createClient(contract, 'api', { fetch: kit.browser(ann) })
		expect(
			(await annApi.members.list({ orgId: 'acme' })).items.map((item) =>
				item.principalId
			),
		)
			.toContain(ann.id)
		await ownerApi.members.remove({ orgId: 'acme', principalId: ann.id })
		expect(await statusOf(annApi.members.list({ orgId: 'acme' }))).toBe(403)
	})
}
```

- `testKit(app, { membership })` replaces the stand-in with your own `IamMembershipRpc`; that kit accepts no
  invitation. `@fabrika/app/testing` exports the types of the options: `IamMembershipRpc` (`membership`),
  `ChallengeFetch` (`challengeFetch`) and `FileScanner` (`scanner`). Import them from there, beside `testKit`.
- `kit.testCaller(grants, { disabled: true })` is a person an operator disabled: the directory lists and finds them
  with `disabled: true`, so an assignment of them answers your handler's 400, and their own requests are refused (401 for
  a session, 403 for a key).
- `kit.runJob('<job>')` runs a cron job once and answers `{ status: 'succeeded', attempts }`. A job's `ctx.links`
  reaches the kit's stand-in IAM under the job's own key, so a job that declares `issues` issues and revokes links in a
  plain `testKit` and under `fabrika app dev`, as IAM allows it: for its declared mount only.
- A mutation that kicks (`kicks`, `ctx.kick`) starts its job in the background of the call. `kit.drain()` waits for
  those runs, and `kit.runJob` first waits for them; every generated access case drains before it answers. The kicked
  run may start at once, so arm a fault before the call, never between the call and the run.
- `await kit.runDueJobs({ within: 3 * 3600000 })` runs every job with a wake due now or within `within` milliseconds
  (0 by default) once, as the Cloudflare object's alarm runs it: a cron job's next fire, a kick, a failed run's retry.
  It answers `[{ job, result }]` for the runs it started, and first waits for the kicked runs. Without it the kit fires
  no wake: a cron job runs only through `runJob` or `runDueJobs`. Only the wakes move, never the clock: a handler's
  `new Date()` and a queue row's due time stay real, so a row due later is not claimed early. A second call does not run
  a cron fire the first one ran early. A failed run of a job with `retries` is due again after its backoff, at most a
  second for the first retry, so `runDueJobs({ within: 2000 })` runs it. It needs the application's data layer.
- `kit.mail` is the stand-in for every job's mail transport (`MemoryEmailSender` of `@fabrika/app/testing`), so a test
  needs no mail variable. `kit.mail.accepted` is what reached the inbox, once per key, and `kit.mail.handoffs` every
  send with its `answer`. `refuse(code?)`, `unavailable()`, `unreachable()`, `loseAnswers(n)` and `during(hook)`
  inject a failure until `heal()`. A message carries the key the transport got, `transportMailKey(kit.mailKeyScope,
  key)`. Model a transport that does not deduplicate with `testKit(app, { mail: new MemoryEmailSender({ capabilities:
  { idempotent: false, confirmation: 'queued' } }) })`. The test e-mail in `references/public-intake.md` is an example.
- An application with files passes `files: new MemoryFileObjects()` (`@fabrika/platform/testing`) to `testKit`;
  without it the application does not boot. With `scan: true`, an upload stays `quarantined` until
  `kit.runJob(FILE_SCAN_JOB)` (`@fabrika/app/implement`) runs with a `scanner` passed to `testKit`: a `FileScanner`
  stand-in, or the real ClamAV one, `clamscanScanner()` of `@fabrika/app/bun`.
- A challenge passes once: a second submission with the same token answers 400 `challenge_failed`. For an ALTCHA
  challenge, `await kit.solveChallenge(api.<procedure>)` fetches one through the kit's proxy and solves it, so send a
  fresh one with each submission; the kit issues the cheapest challenge and verifies it as production does. For a
  Turnstile challenge send a fresh token with each submission (`crypto.randomUUID()`), also when the test's
  `challengeFetch` answers success. `passingChallenge` (`@fabrika/app/testing`) is a `challengeFetch` that passes every
  token; a stand-in of your own receives the check (`hostname`, `action`) a passing answer must confirm as its second
  argument.
- `testKit` takes no `deps`, and a test may not start a server (`Bun.serve` is `forbidden-global`). Stand in for an
  outbound dependency through its variables: `env` points it at a test URL, and `spyOn(globalThis, 'fetch')` answers
  that URL only and passes every other request on to the real `fetch`.
- `defineDeps(build)` runs at every boot, the generated tests' too, which set no application variable: read a variable
  where it is used, not in `build` (`references/public-intake.md`). A handler that calls an outbound dependency fails its
  generated cases with 500, so an endpoint they cover writes an outbox row a job sends (`references/endpoint.md`).
- Run with `bun test --isolate`: the generated test boots the same application, and its data layer binds once per
  process. Import the test kits from test files only (`test-only-import`).
- No `.skip`, `.only` or test without an assertion, and no `mock.module` of `bun:test` or `@fabrika/*`.

## Clicking through the screens

`bunx fabrika app dev` serves the application through the same kit, seeded by `dev/seed.ts`, with a caller picker at
`/__fabrika/dev` and a toolbar on every SPA page: `references/dev.md`.
