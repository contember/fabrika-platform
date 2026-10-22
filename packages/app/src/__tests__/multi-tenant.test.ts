// Membership, share links and a GitHub webhook through `boot`'s real pipeline, on a REAL Postgres (the share link's
// chain re-check and the webhook tables need it); IAM is a recording stand-in. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset (see scoped-database.test.ts).

import { type ContractApp, LINK_BOOTSTRAP_SCRIPT, type SpaAssets, type WorkloadTokenSource } from '@fabrika/app/implement'
import { DELEGATION_HEADER, type PermissionEntry } from '@fabrika/auth-core'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
	bootApp,
	environment,
	errorType,
	frameworkEnvFor,
	grant,
	linkToken,
	resultOf,
	send,
	type Sent,
	token,
	workloadTokensFor,
} from './fixtures/implement/harness'
import { RecordingMembership } from './fixtures/multi-tenant/iam'
import { migration } from './fixtures/multi-tenant/migration'
import { multiTenantApp, type Seen } from './fixtures/multi-tenant/src/app'
import { githubApp } from './fixtures/multi-tenant/src/github'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`multi-tenant.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `tenant-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const W1 = { type: 'workspace', value: 'w1' }
const PROXY = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', [DELEGATION_HEADER]: 'grant-1', 'X-Request-Id': 'req-1' }

/** Serves the share SPA's document as HTML, the way a Vite build's `index.html` reaches the browser. */
const htmlAssets: SpaAssets = {
	serve: (mount) =>
		Promise.resolve(
			new Response(
				`<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/s/app.js"></script></head><body>${mount.dir}</body></html>`,
				{
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				},
			),
		),
}

let database: Database
const opened: Database[] = []

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** A fresh boot over the shared schema: its own data layer, IAM stand-in and webhook record. */
function start(workloadTokens?: WorkloadTokenSource): { app: ContractApp; iam: RecordingMembership; seen: Seen } {
	const iam = new RecordingMembership()
	const seen: Seen = { pushes: [], keys: [], failNextPush: false }
	const connection = openPostgres({ url, schema, max: 2 })
	opened.push(connection)
	const app = multiTenantApp(seen)
	const options = { database: connection, membership: iam, assets: htmlAssets, workloadTokens: workloadTokens ?? workloadTokensFor(app) }
	return { app: bootApp(app, options), iam, seen }
}

async function seedNote(workspace: string, title: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, $2, $3, 'user-9', 1)`, [id, workspace, title])
	)
	return id
}

async function count(table: string, where = 'true'): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.${table} where ${where}`))
	return Number(row?.n)
}

const inW1 = (...actions: string[]): PermissionEntry[] => actions.map((action) => grant(action, W1))

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
	database = openPostgres({ url, schema, max: 1 })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	for (const connection of [database, ...opened]) {
		await connection.close()
	}
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('creates', () => {
	test("IAM creates the value with the proxy's delegation and the caller's token; the handler gets ctx.created", async () => {
		const { app, iam } = start()
		const caller = await token('user', [grant('workspaces.create')])
		expect(resultOf(await send(app, '/api/workspaces.create', { token: caller, body: {}, headers: PROXY }))).toEqual({ workspace: 'w-new' })
		expect(iam.calls).toEqual([{
			method: 'createScope',
			input: { app: 'notes@prod', credential: caller, requestId: 'req-1', delegation: 'grant-1', dimension: 'workspace' },
		}])
	})

	test("without the proxy's delegation grant it is a 503 and IAM is not asked", async () => {
		const { app, iam } = start()
		const { [DELEGATION_HEADER]: _grant, ...withoutGrant } = PROXY
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const sent = await send(app, '/api/workspaces.create', {
				token: await token('user', [grant('workspaces.create')]),
				body: {},
				headers: withoutGrant,
			})
			expect(sent.status).toBe(503)
		} finally {
			log.mockRestore()
		}
		expect(iam.calls).toEqual([])
	})

	test("IAM's refusal is the caller's answer, and an unreachable IAM is a 503", async () => {
		const { app, iam } = start()
		const caller = await token('user', [grant('workspaces.create')])
		iam.refuse = { ok: false, reason: 'not_allowed' }
		expect((await send(app, '/api/workspaces.create', { token: caller, body: {}, headers: PROXY })).status).toBe(403)
		iam.refuse = { ok: false, reason: 'invalid_delegation' }
		expect((await send(app, '/api/workspaces.create', { token: caller, body: {}, headers: PROXY })).status).toBe(403)
		iam.unreachable = true
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await send(app, '/api/workspaces.create', { token: caller, body: {}, headers: PROXY })).status).toBe(503)
		} finally {
			log.mockRestore()
		}
	})
})

describe.skipIf(!hasPostgres)('ctx.members', () => {
	test('assign, revoke and list ask IAM about the checked value, with the delegation of this request', async () => {
		const { app, iam } = start()
		const manager = await token('user', inW1('notes.admin', 'notes.read'))
		const invite = { workspaceId: 'w1', email: 'new@notes.test', role: 'editor' }
		expect(resultOf(await send(app, '/api/members.invite', { token: manager, body: invite, headers: PROXY }))).toEqual({ invitationId: 'inv-1' })
		expect(resultOf(await send(app, '/api/members.remove', { token: manager, body: { workspaceId: 'w1', principalId: 'user-2' }, headers: PROXY })))
			.toEqual({ ok: true })
		expect(resultOf(await send(app, '/api/members.count', { token: manager, body: { workspaceId: 'w1' }, headers: PROXY }))).toEqual({
			members: 1,
			invitations: 0,
		})
		const common = { app: 'notes@prod', credential: manager, requestId: 'req-1' }
		expect(iam.calls).toEqual([
			{ method: 'assignMember', input: { ...common, delegation: 'grant-1', scope: W1, role: 'editor', member: { email: 'new@notes.test' } } },
			{ method: 'revokeMember', input: { ...common, delegation: 'grant-1', scope: W1, member: { principalId: 'user-2', role: null } } },
			{ method: 'listMembers', input: { ...common, scope: W1 } },
		])
	})

	test('a caller without the members.manage action there is refused before IAM is asked', async () => {
		const { app, iam } = start()
		const editor = await token('user', inW1('notes.read', 'notes.write'))
		const sent = await send(app, '/api/members.invite', {
			token: editor,
			body: { workspaceId: 'w1', email: 'x@notes.test', role: 'owner' },
			headers: PROXY,
		})
		expect(sent.status).toBe(403)
		expect(iam.calls).toEqual([])
	})

	test('the last creator stays: 409, with no envelope detail beyond the reason', async () => {
		const { app, iam } = start()
		iam.refuse = { ok: false, reason: 'last_creator' }
		const sent = await send(app, '/api/members.remove', {
			token: await token('user', inW1('notes.admin')),
			body: { workspaceId: 'w1', principalId: 'user-1' },
			headers: PROXY,
		})
		expect(sent.status).toBe(409)
		expect(errorType(sent)).toBe('conflict')
	})
})

describe.skipIf(!hasPostgres)('share links', () => {
	test('ctx.links.issue asks IAM for a key bound to the whole chain and answers the fragment URL', async () => {
		const { app, iam } = start()
		const note = await seedNote('w1', 'shared note')
		const sharer = await token('user', inW1('notes.share'))
		expect(resultOf(await send(app, '/api/notes.share', { token: sharer, body: { id: note, days: 7 }, headers: PROXY }))).toEqual({
			id: 'link-1',
			url: '/s/#px_sharedkey123',
		})
		expect(iam.calls).toEqual([{
			method: 'issueLink',
			input: {
				app: 'notes@prod',
				credential: sharer,
				requestId: 'req-1',
				mount: 'shared',
				chain: [{ type: 'note', value: note }, W1],
				days: 7,
			},
		}])
	})

	test('a link reaches its note, and stops working after the note moves', async () => {
		const { app } = start()
		const note = await seedNote('w1', 'moving note')
		const holder = await linkToken([grant('notes.read', { type: 'note', value: note })], {
			mount: 'shared',
			chain: [{ type: 'note', value: note }, W1],
		})
		expect(resultOf(await send(app, '/s/api/note', { token: holder, body: {} }))).toEqual({ id: note, title: 'moving note' })
		await admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = 'w2' where id = $1`, [note]))
		const moved = await send(app, '/s/api/note', { token: holder, body: {} })
		expect(moved.status).toBe(404)
		expect(moved.body).toEqual({ error: { type: 'not_found', message: 'This link no longer reaches its object' } })
	})

	test('a key of another link mount, and a person, are refused', async () => {
		const { app } = start()
		const note = await seedNote('w1', 'private note')
		const scope = { type: 'note', value: note }
		const other = await linkToken([grant('notes.read', scope)], { mount: 'other', chain: [scope, W1] })
		expect((await send(app, '/s/api/note', { token: other, body: {} })).status).toBe(403)
		const person = await token('user', [grant('notes.read', scope)])
		expect((await send(app, '/s/api/note', { token: person, body: {} })).status).toBe(403)
	})

	test('the share SPA is served with the fragment bootstrap as its first script, and the bootstrap itself', async () => {
		const { app } = start()
		const page = await send(app, '/s/', { headers: {} })
		expect(page.status).toBe(200)
		expect(page.body).toBe(
			'<!doctype html><html><head><script src="/s/__fabrika-share.js"></script><meta charset="utf-8"><script type="module" src="/s/app.js"></script></head><body>dist/share</body></html>',
		)
		const bootstrap = await send(app, '/s/__fabrika-share.js', { headers: {} })
		expect(bootstrap.body).toBe(LINK_BOOTSTRAP_SCRIPT)
		expect(bootstrap.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
		expect(bootstrap.headers.get('Referrer-Policy')).toBe('no-referrer')
	})
})

describe.skipIf(!hasPostgres)('a GitHub webhook bound by a mutation that declares binds', () => {
	/** A boot of the kit application that binds the webhook; `tokens` stands in for IAM's exchange of its workload keys. */
	function startHook(tokens?: (app: ReturnType<typeof githubApp>['implementation']) => WorkloadTokenSource): { app: ContractApp; seen: Seen } {
		const seen: Seen = { pushes: [], keys: [], failNextPush: false }
		const connection = openPostgres({ url, schema, max: 2 })
		opened.push(connection)
		const { implementation, variables } = githubApp(seen)
		const app = bootApp(implementation, {
			database: connection,
			membership: new RecordingMembership(),
			environment: environment({ ...frameworkEnvFor(implementation), ...variables }),
			workloadTokens: tokens?.(implementation) ?? workloadTokensFor(implementation),
		})
		return { app, seen }
	}

	const hook = { 'Content-Type': 'application/json' }
	const push = (repository: number, message: string) => ({
		ref: 'refs/heads/main',
		repository: { id: repository, full_name: 'acme/notes', private: true },
		head_commit: { message, author: { name: 'someone' } },
		sender: { login: 'someone' },
	})

	async function bind(app: ContractApp, account: string): Promise<{ id: string; url: string; secret: string }> {
		const manager = await token('user', inW1('notes.admin'))
		const result = resultOf(await send(app, '/api/webhooks.connect', { token: manager, body: { workspaceId: 'w1', account }, headers: PROXY }))
		if (typeof result !== 'object' || result === null || !('id' in result) || !('url' in result) || !('secret' in result)) {
			throw new Error('no binding')
		}
		return { id: String(result.id), url: String(result.url), secret: String(result.secret) }
	}

	async function deliver(app: ContractApp, path: string, secret: string, payload: unknown, delivery: string): Promise<Sent> {
		const body = JSON.stringify(payload)
		const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
		return await send(app, path, { body: payload, headers: { ...hook, 'X-Hub-Signature-256': signature, 'X-GitHub-Delivery': delivery } })
	}

	test('a member who manages the workspace binds an account; the framework generates the secret and the URL', async () => {
		const { app } = startHook()
		const binding = await bind(app, 'repository:42')
		expect(binding.url).toBe(`/hooks/github/${binding.id}`)
		expect(binding.secret).toMatch(/^[0-9a-f]{64}$/)
		const editor = await token('user', inW1('notes.write', 'notes.read'))
		const refused = await send(app, '/api/webhooks.connect', { token: editor, body: { workspaceId: 'w1', account: 'repository:42' }, headers: PROXY })
		expect(refused.status).toBe(403)
	})

	test('a delivery runs once with a Ref of the bound workspace and only the declared fields; a replay is ignored', async () => {
		const { app, seen } = startHook()
		const binding = await bind(app, 'repository:42')
		const delivered = await deliver(app, binding.url, binding.secret, push(42, 'first push'), 'd-1')
		expect(delivered.status).toBe(200)
		expect(seen.pushes).toEqual([{ ref: 'refs/heads/main', repository: { id: 42, full_name: 'acme/notes' }, head_commit: { message: 'first push' } }])
		expect(await count('notes', `title = 'first push' and workspace_id = 'w1' and created_by = 'webhook:${binding.id}'`)).toBe(1)

		const replay = await deliver(app, binding.url, binding.secret, push(42, 'first push'), 'd-1')
		expect(replay.status).toBe(200)
		expect(seen.pushes).toHaveLength(1)
		expect(await count('notes', `title = 'first push'`)).toBe(1)
	})

	test('a replay with only its unsigned delivery header changed is still a replay', async () => {
		const { app, seen } = startHook()
		const binding = await bind(app, 'repository:42')
		expect((await deliver(app, binding.url, binding.secret, push(42, 'header replay'), 'd-original')).status).toBe(200)
		expect((await deliver(app, binding.url, binding.secret, push(42, 'header replay'), 'd-forged')).status).toBe(200)
		expect(seen.pushes).toHaveLength(1)
		expect(await count('notes', `title = 'header replay'`)).toBe(1)
		// The key is the binding's hash of the signed body: another binding of the same body is another delivery.
		const other = await bind(app, 'repository:42')
		expect((await deliver(app, other.url, other.secret, push(42, 'header replay'), 'd-original')).status).toBe(200)
		expect(seen.keys).toHaveLength(2)
		expect(seen.keys[0]).not.toBe(seen.keys[1])
	})

	test('a delivery signed for another binding is refused, and so is one naming another account', async () => {
		const { app, seen } = startHook()
		const ours = await bind(app, 'repository:42')
		const theirs = await bind(app, 'repository:42')
		expect((await deliver(app, ours.url, theirs.secret, push(42, 'forged'), 'd-2')).status).toBe(401)
		expect((await deliver(app, ours.url, ours.secret, push(43, 'other repository'), 'd-3')).status).toBe(403)
		expect((await deliver(app, '/hooks/github/0190a0a0-0000-7000-8000-0000000000ff', ours.secret, push(42, 'unbound'), 'd-4')).status).toBe(404)
		expect(seen.pushes).toEqual([])
	})

	test("a delivery IAM gives no authority to is a 503, not recorded, so GitHub's redelivery runs it", async () => {
		let refusing = true
		const { app, seen } = startHook((implementation) => {
			const signing = workloadTokensFor(implementation)
			return { exchange: (input) => refusing ? Promise.resolve({ ok: false, reason: 'invalid_key' }) : signing.exchange(input) }
		})
		const binding = await bind(app, 'repository:42')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await deliver(app, binding.url, binding.secret, push(42, 'credentialed'), 'd-10')).status).toBe(503)
		} finally {
			log.mockRestore()
		}
		expect(seen.pushes).toEqual([])
		refusing = false
		expect((await deliver(app, binding.url, binding.secret, push(42, 'credentialed'), 'd-10-redelivered')).status).toBe(200)
		expect(seen.pushes).toHaveLength(1)
		expect(await count('notes', `title = 'credentialed'`)).toBe(1)
	})

	test("a declared action the webhook's token does not carry is a 503, and its handler does not run", async () => {
		const { app, seen } = startHook((implementation) =>
			workloadTokensFor(implementation, (workload) => workload.kind === 'webhook' ? [] : workload.actions)
		)
		const binding = await bind(app, 'repository:42')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await deliver(app, binding.url, binding.secret, push(42, 'narrowed'), 'd-11')).status).toBe(503)
		} finally {
			log.mockRestore()
		}
		expect(seen.pushes).toEqual([])
		expect(await count('notes', `title = 'narrowed'`)).toBe(0)
	})

	test('a run that failed after its write rolls it back and runs again with the same key; a success never runs again', async () => {
		const { app, seen } = startHook()
		const binding = await bind(app, 'repository:42')
		seen.failNextPush = true
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			// The delivery header is unsigned, the caller's word: it reaches no log line.
			expect((await deliver(app, binding.url, binding.secret, push(42, 'retried'), 'RequestSecretMarker-5')).status).toBe(500)
			const lines = log.mock.calls.map((call) => String(call[0]))
			expect(lines).toContain("fabrika: github: delivery_failed; the provider's redelivery runs it again")
			expect(lines.join('\n')).not.toContain('RequestSecretMarker')
		} finally {
			log.mockRestore()
		}
		// The failed run's write is rolled back with its transaction.
		expect(await count('notes', `title = 'retried'`)).toBe(0)
		expect((await deliver(app, binding.url, binding.secret, push(42, 'retried'), 'd-5-redelivered')).status).toBe(200)
		expect(seen.keys).toHaveLength(2)
		expect(seen.keys[1]).toBe(seen.keys[0])
		expect(seen.keys[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(await count('notes', `title = 'retried'`)).toBe(1)
		expect((await deliver(app, binding.url, binding.secret, push(42, 'retried'), 'd-5-again')).status).toBe(200)
		expect(seen.keys).toHaveLength(2)
	})

	test('unbinding removes the binding from its own workspace only', async () => {
		const { app } = startHook()
		const binding = await bind(app, 'installation:7')
		const manager = await token('user', [...inW1('notes.admin'), grant('notes.admin', { type: 'workspace', value: 'w2' })])
		const unbind = (workspaceId: string) =>
			send(app, '/api/webhooks.disconnect', { token: manager, body: { workspaceId, id: binding.id }, headers: PROXY })
		expect(resultOf(await unbind('w2'))).toEqual({ removed: false })
		expect(resultOf(await unbind('w1'))).toEqual({ removed: true })
		const installation = { ...push(42, 'gone'), installation: { id: 7 } }
		expect((await deliver(app, binding.url, binding.secret, installation, 'd-6')).status).toBe(404)
	})
})
