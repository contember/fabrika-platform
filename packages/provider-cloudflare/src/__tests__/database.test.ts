import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { postgresRoleUrl } from '../../../platform-node/src/application-postgres-roles'
import { generateWranglerConfigs } from '../bounds'
import {
	hyperdriveConfigName,
	hyperdriveConfigsOver,
	HyperdriveDatabase,
	type HyperdriveUpsert,
	localDatabaseConnection,
	PENDING_HYPERDRIVE_ID,
	runtimeOrigin,
} from '../database'

const PROVISIONING = 'postgres://owner:pr%40vision-secret@db.example.com:6543/notes_db?sslmode=require'
const ID = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

interface Call {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	readonly body: unknown
}

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ok = (result: unknown, extra: Record<string, unknown> = {}): Response =>
	json(200, { success: true, errors: [], messages: [], result, ...extra })

/** A fake Hyperdrive API: `answer` gets each call in order and returns its response. */
const fakeApi = (answer: (call: Call, index: number) => Response) => {
	const calls: Call[] = []
	const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
		const headers = new Headers(init.headers)
		const call: Call = {
			url,
			method: init.method ?? 'GET',
			authorization: headers.get('Authorization'),
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		}
		calls.push(call)
		return answer(call, calls.length - 1)
	}
	return { calls, configs: hyperdriveConfigsOver(fetcher) }
}

const upsert = (): HyperdriveUpsert => ({
	accountId: 'acc-1',
	apiToken: 'tok-1',
	name: 'stage-notes-database',
	origin: runtimeOrigin(PROVISIONING, 'notes'),
	signal: new AbortController().signal,
})

const written = (id: string, caching: unknown = { disabled: true }) => ({
	id,
	name: 'stage-notes-database',
	origin: { scheme: 'postgres', host: 'db.example.com', port: 6543, database: 'notes_db', user: 'run_notes' },
	caching,
})

const BASE = 'https://api.cloudflare.com/client/v4/accounts/acc-1/hyperdrive/configs'

describe('the Hyperdrive config of an application on Postgres', () => {
	test('the runtime origin is the runtime role postgresRoleUrl derives, on the provisioning host', () => {
		const origin = runtimeOrigin(PROVISIONING, 'notes')
		const expected = new URL(postgresRoleUrl(PROVISIONING, 'run_notes'))
		expect(origin).toEqual({
			host: 'db.example.com',
			port: 6543,
			database: 'notes_db',
			user: 'run_notes',
			password: decodeURIComponent(expected.password),
		})
		expect(localDatabaseConnection(PROVISIONING, 'notes')).toBe(expected.toString())
		expect(origin.password).not.toContain('vision-secret')
		expect(runtimeOrigin('postgres://owner:pw@db.example.com/notes_db', 'my-app')).toMatchObject({ port: 5432, user: 'run_my_app' })
	})

	test('a provisioning URL that cannot be used is refused without being quoted', () => {
		for (const url of ['not a url pr-secret', 'postgres://owner@db.example.com/notes_db', 'mysql://owner:pr-secret@db.example.com/notes_db']) {
			let message = ''
			try {
				runtimeOrigin(url, 'notes')
			} catch (error) {
				message = error instanceof Error ? error.message : String(error)
			}
			expect(message).not.toBe('')
			expect(message).not.toContain('pr-secret')
			expect(message).not.toContain('db.example.com')
		}
	})

	test('the config is named after the deployment, and a name outside the alphabet is refused', () => {
		expect(hyperdriveConfigName({ env: 'stage', appId: 'notes' })).toBe('stage-notes-database')
		expect(() => hyperdriveConfigName({ env: 'Stage', appId: 'notes' })).toThrow('is not a Hyperdrive config name')
		expect(() => hyperdriveConfigName({ env: 'stage', appId: 'notes/../x' })).toThrow('is not a Hyperdrive config name')
	})

	test('an absent config is created with caching disabled, over the runtime role', async () => {
		const api = fakeApi((call) => call.method === 'GET' ? ok([{ id: OTHER, name: 'prod-notes-database' }]) : ok(written(ID)))
		expect(await api.configs.upsert(upsert())).toEqual({ id: ID })
		expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}?page=1`, `POST ${BASE}`])
		expect(api.calls.every((call) => call.authorization === 'Bearer tok-1')).toBe(true)
		const origin = runtimeOrigin(PROVISIONING, 'notes')
		expect(api.calls[1]?.body).toEqual({
			name: 'stage-notes-database',
			origin: { scheme: 'postgres', host: 'db.example.com', port: 6543, database: 'notes_db', user: 'run_notes', password: origin.password },
			caching: { disabled: true },
		})
	})

	test('an existing config is replaced in place, found on a later page', async () => {
		const first = Array.from({ length: 100 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), name: `other-${index}` }))
		const api = fakeApi((call, index) => {
			if (index === 0) return ok(first, { result_info: { page: 1, per_page: 100, total_count: 101 } })
			if (index === 1) return ok([{ id: ID, name: 'stage-notes-database' }], { result_info: { page: 2, per_page: 100, total_count: 101 } })
			return ok(written(ID))
		})
		expect(await api.configs.upsert(upsert())).toEqual({ id: ID })
		expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`GET ${BASE}?page=1`,
			`GET ${BASE}?page=2`,
			`PUT ${BASE}/${ID}`,
		])
		expect(api.calls[2]?.body).toMatchObject({ name: 'stage-notes-database', caching: { disabled: true } })
	})

	test('the server picks the page size: a short page with more to come is no last page', async () => {
		// 25 configs, 20 a page, whatever the client asks for; ours is the 23rd.
		const all = Array.from({ length: 25 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), name: `other-${index}` }))
		all[22] = { id: ID, name: 'stage-notes-database' }
		const api = fakeApi((call) => {
			if (call.method !== 'GET') return ok(written(ID))
			const page = Number(new URL(call.url).searchParams.get('page'))
			return ok(all.slice((page - 1) * 20, page * 20), { result_info: { page, per_page: 20, count: 20, total_count: 25 } })
		})
		expect(await api.configs.upsert(upsert())).toEqual({ id: ID })
		expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}?page=1`, `GET ${BASE}?page=2`, `PUT ${BASE}/${ID}`])
	})

	test('a server that ignores the page ends the list when a page adds nothing, and a repeated config counts once', async () => {
		const page = Array.from({ length: 100 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), name: `other-${index}` }))
		page[7] = { id: ID, name: 'stage-notes-database' }
		const api = fakeApi((call) => call.method === 'GET' ? ok(page, { result_info: { total_count: 1000 } }) : ok(written(ID)))
		expect(await api.configs.upsert(upsert())).toEqual({ id: ID })
		expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}?page=1`, `GET ${BASE}?page=2`, `PUT ${BASE}/${ID}`])
		// An empty page ends it as well.
		const empty = fakeApi((call, index) => {
			if (call.method !== 'GET') return ok(written(ID))
			return ok(index === 0 ? [{ id: ID, name: 'stage-notes-database' }] : [], { result_info: { total_pages: 5 } })
		})
		expect(await empty.configs.upsert(upsert())).toEqual({ id: ID })
		expect(empty.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'PUT'])
	})

	test('a list that does not end is refused after a bounded number of pages', async () => {
		const api = fakeApi((call) => {
			const page = Number(new URL(call.url).searchParams.get('page'))
			return ok([{ id: page.toString(16).padStart(32, '0'), name: `other-${page}` }], { result_info: { total_pages: 1_000_000 } })
		})
		await expect(api.configs.upsert(upsert())).rejects.toThrow('listing the Hyperdrive configs did not end within 100 pages')
		expect(api.calls).toHaveLength(100)
	})

	test('two configs of the name are refused, not guessed between', async () => {
		const api = fakeApi(() => ok([{ id: ID, name: 'stage-notes-database' }, { id: OTHER, name: 'stage-notes-database' }]))
		await expect(api.configs.upsert(upsert())).rejects.toThrow('holds 2 Hyperdrive configs named `stage-notes-database`')
		expect(api.calls).toHaveLength(1)
	})

	test('a config that does not read back with caching disabled fails the write', async () => {
		const { caching: _, ...withoutCaching } = written(ID)
		for (const result of [written(ID, { disabled: false, max_age: 60 }), withoutCaching]) {
			const api = fakeApi((call) => call.method === 'GET' ? ok([]) : ok(result))
			await expect(api.configs.upsert(upsert())).rejects.toThrow('does not read back with caching disabled')
		}
	})

	test('a result that is not the config written is refused', async () => {
		const wrongId = fakeApi((call) => call.method === 'GET' ? ok([{ id: ID, name: 'stage-notes-database' }]) : ok(written(OTHER)))
		await expect(wrongId.configs.upsert(upsert())).rejects.toThrow('returned an unreadable result')
		const badId = fakeApi((call) => call.method === 'GET' ? ok([]) : ok(written('not-an-id')))
		await expect(badId.configs.upsert(upsert())).rejects.toThrow('returned an unreadable result')
	})

	test('a failure names the status and the Cloudflare codes, never the body or the password', async () => {
		const password = runtimeOrigin(PROVISIONING, 'notes').password
		const api = fakeApi((call) =>
			call.method === 'GET'
				? ok([])
				: json(400, {
					success: false,
					errors: [{ code: 2008, message: `could not connect as run_notes:${password}@db.example.com` }],
					messages: [],
					result: null,
				})
		)
		let message = ''
		try {
			await api.configs.upsert(upsert())
		} catch (error) {
			message = error instanceof Error ? error.message : String(error)
		}
		expect(message).toBe('cloudflare: creating the Hyperdrive config `stage-notes-database` failed (HTTP 400, Cloudflare error 2008)')
		const unreadable = fakeApi(() => new Response('<html>bad gateway</html>', { status: 502 }))
		await expect(unreadable.configs.upsert(upsert())).rejects.toThrow('listing the Hyperdrive configs failed (HTTP 502)')
		const unreachable = hyperdriveConfigsOver(() => Promise.reject(new Error(`ECONNRESET ${password}`)))
		await expect(unreachable.upsert(upsert())).rejects.toThrow('listing the Hyperdrive configs did not reach the Cloudflare API')
	})

	test('the binding writes the id handed out, the pending id before, and a local connection string locally', async () => {
		const holder: { id: string | null } = { id: null }
		const worker = (binding: HyperdriveDatabase): Worker =>
			new Worker({ dir: '.', name: 'notes', compatibility_flags: [], bindings: { FABRIKA_DATABASE: binding } })
		const generated = async (binding: HyperdriveDatabase): Promise<unknown> =>
			(await generateWranglerConfigs(worker(binding), 'stage')).configs[0]?.config.hyperdrive
		expect(await generated(new HyperdriveDatabase(holder))).toEqual([{ binding: 'FABRIKA_DATABASE', id: PENDING_HYPERDRIVE_ID }])
		holder.id = ID
		expect(await generated(new HyperdriveDatabase(holder))).toEqual([{ binding: 'FABRIKA_DATABASE', id: ID }])
		expect(await generated(new HyperdriveDatabase(holder, { connectionString: 'postgres://run_notes:x@127.0.0.1:5432/db' }))).toEqual([
			{ binding: 'FABRIKA_DATABASE', id: 'local', localConnectionString: 'postgres://run_notes:x@127.0.0.1:5432/db' },
		])
	})
})
