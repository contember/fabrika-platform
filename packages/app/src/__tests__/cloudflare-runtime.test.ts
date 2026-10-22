// A contract application on Cloudflare runs in its environment's one Durable Object (ADR-0065): the Worker forwards
// every request and the minute tick with the proxy secret, the object migrates its SQLite once, boots the application
// and serves it. Lopata runs the Worker, the object and the R2 bucket in process.

import { compileContract } from '@fabrika/app/contract'
import { boot, BootError, serve } from '@fabrika/app/implement'
import { PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { openSqlite } from '@fabrika/db/sqlite'
import { ObjectExistsError, ObjectTooLargeError } from '@fabrika/platform'
import { Database as BunDatabase } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import {
	applicationMigrations,
	CLOUDFLARE_APPLICATION_BINDING,
	CLOUDFLARE_APPLICATION_CLASS,
	CLOUDFLARE_FILES_BINDING,
	GENERATED_MIGRATIONS_FILE,
	generatedEntry,
	writeGeneratedEntry,
} from '../build'
import { type ApplicationState, createContractWorker, FabrikaApplication } from '../cloudflare'
import { R2_PART_BYTES, r2FileObjectStore } from '../cloudflare/r2-files'
import { type NotesApp, notesApp } from './cloudflare-fixture/src/app'
import { app as notesKit } from './cloudflare-fixture/src/app-kit'
import { tables } from './cloudflare-fixture/src/db/tables'
import type { NotesWorld } from './cloudflare-fixture/src/world'
import {
	endpointHeaderFor,
	environment,
	frameworkEnvFor,
	grant,
	keepingProcessEnvironment,
	keySource,
	ORIGIN,
	PROXY_SECRET,
	token,
	workloadTokensFor,
} from './fixtures/implement/harness'

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-fixture')
const WORKSPACE = { type: 'workspace', value: 'w1' }

/** IAM's application entrypoint as the object reads it: the key set and the workload token exchange. */
function iamBinding(served: NotesApp) {
	const tokens = workloadTokensFor(served.implementation)
	return { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) }
}

function variablesOf(served: NotesApp, secret: string | null = PROXY_SECRET): Record<string, string> {
	return { ...frameworkEnvFor(served.implementation), ...served.variables, ...(secret === null ? {} : { FABRIKA_PROXY_SECRET: secret }) }
}

interface Deployed {
	readonly testEnv: TestEnv
	readonly served: NotesApp
	readonly world: NotesWorld
}

const deployed: TestEnv[] = []
afterEach(() => {
	for (const testEnv of deployed.splice(0)) {
		testEnv.dispose()
	}
})

/** The fixture as the provider deploys it: the Worker, its object class and binding, and the files bucket. */
async function deploy(options: { readonly secret?: string | null } = {}): Promise<Deployed> {
	const world: NotesWorld = { runs: [] }
	const served = notesApp(world)
	const migrations = await applicationMigrations(FIXTURE_ROOT)
	const worker = createContractWorker(() => Promise.resolve({ default: served.implementation }), { migrations })
	const testEnv = await createTestEnv({
		worker: { default: worker, [CLOUDFLARE_APPLICATION_CLASS]: FabrikaApplication },
		bindings: {
			[CLOUDFLARE_APPLICATION_BINDING]: { type: 'durable-object', className: CLOUDFLARE_APPLICATION_CLASS },
			[CLOUDFLARE_FILES_BINDING]: 'r2',
		},
		vars: variablesOf(served, options.secret === undefined ? PROXY_SECRET : options.secret),
	})
	deployed.push(testEnv)
	testEnv.env['IAM'] = iamBinding(served)
	return { testEnv, served, world }
}

async function call(target: Deployed, procedure: string, input: unknown, perms = [grant('notes.read', WORKSPACE), grant('notes.write', WORKSPACE)]) {
	const path = `/api/notes.${procedure}`
	return await target.testEnv.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'X-Fabrika-Token': await token('user', perms),
				'X-Fabrika-Endpoint': endpointHeaderFor(target.served.implementation, 'POST', path) ?? '',
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: JSON.stringify(input),
		}),
	)
}

async function titles(target: Deployed): Promise<unknown> {
	return await (await call(target, 'titles', { workspaceId: 'w1' })).json()
}

/** The object as another Worker that binds the exported class reaches it: past the application's Worker. */
async function fetchObject(testEnv: TestEnv, request: Request): Promise<Response> {
	const namespace = testEnv.env[CLOUDFLARE_APPLICATION_BINDING]
	const idFromName: unknown = typeof namespace === 'object' && namespace !== null ? Reflect.get(namespace, 'idFromName') : undefined
	const get: unknown = typeof namespace === 'object' && namespace !== null ? Reflect.get(namespace, 'get') : undefined
	if (typeof idFromName !== 'function' || typeof get !== 'function') {
		throw new Error('no object namespace')
	}
	const stub: unknown = Reflect.apply(get, namespace, [Reflect.apply(idFromName, namespace, ['application'])])
	const fetchStub: unknown = typeof stub === 'object' && stub !== null ? Reflect.get(stub, 'fetch') : undefined
	if (typeof fetchStub !== 'function') {
		throw new Error('no object stub')
	}
	const response: unknown = await Reflect.apply(fetchStub, stub, [request])
	if (!(response instanceof Response)) {
		throw new Error('the object answered no Response')
	}
	return response
}

/** Waits for the runs the object handed to `waitUntil`. */
async function runsAfter(world: NotesWorld, count: number): Promise<NotesWorld['runs']> {
	for (let waited = 0; world.runs.length < count && waited < 3000; waited += 10) {
		await Bun.sleep(10)
	}
	await Bun.sleep(50)
	return world.runs
}

describe('the Worker forwards to the environment object', () => {
	test('a write and a read round-trip through the object and its SQLite', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			const created = await call(target, 'create', { workspaceId: 'w1', title: 'first' })
			expect(created.status).toBe(200)
			expect(await call(target, 'create', { workspaceId: 'w1', title: 'second' }).then((response) => response.status)).toBe(200)
			expect(await titles(target)).toEqual({ result: { titles: ['first', 'second'] } })
		})
	})

	test('a handler that throws after its write commits nothing', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			await call(target, 'create', { workspaceId: 'w1', title: 'kept' })
			const failed = await call(target, 'createThenFail', { workspaceId: 'w1', title: 'rolled back' })
			expect(failed.status).toBe(500)
			expect(await titles(target)).toEqual({ result: { titles: ['kept'] } })
		})
	})

	test("a caller's tick header is removed, so a forwarded request is never the minute tick", async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			const response = await target.testEnv.fetch(
				new Request(`${ORIGIN}/healthz`, { headers: { 'X-Fabrika-Tick': String(Date.UTC(2026, 9, 22, 3, 0)) } }),
			)
			expect(response.status).toBe(200)
			expect(await runsAfter(target.world, 1)).toEqual([])
		})
	})

	test('the object refuses a request without the proxy secret, or with another, with an empty 404', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			for (const headers of [new Headers(), new Headers({ [PROXY_SECRET_HEADER]: `${PROXY_SECRET}-not` })]) {
				const refused = await fetchObject(target.testEnv, new Request(`${ORIGIN}/healthz`, { headers }))
				expect(refused.status).toBe(404)
				expect(await refused.text()).toBe('')
			}
			const tick = await fetchObject(target.testEnv, new Request(`${ORIGIN}/`, { method: 'POST', headers: { 'X-Fabrika-Tick': '0' } }))
			expect(tick.status).toBe(404)
			const admitted = await fetchObject(target.testEnv, new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } }))
			expect(admitted.status).toBe(200)
		})
	})

	test('without FABRIKA_PROXY_SECRET the Worker forwards nothing and the object admits nothing', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy({ secret: null })
			await expect(target.testEnv.fetch(new Request(`${ORIGIN}/healthz`))).rejects.toThrow('FABRIKA_PROXY_SECRET is not set')
			await expect(target.testEnv.scheduled({ scheduledTime: Date.UTC(2026, 9, 22, 3, 0) })).rejects.toThrow('FABRIKA_PROXY_SECRET is not set')
			const refused = await fetchObject(target.testEnv, new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } }))
			expect(refused.status).toBe(404)
		})
	})
})

describe('the minute tick', () => {
	test('runs the jobs due in its UTC minute and no other', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			await call(target, 'create', { workspaceId: 'w1', title: 'counted' })
			await target.testEnv.scheduled({ scheduledTime: Date.UTC(2026, 9, 22, 3, 0, 0) })
			expect(await runsAfter(target.world, 1)).toEqual([{ job: 'nightly', notes: 1 }])
			await target.testEnv.scheduled({ scheduledTime: Date.UTC(2026, 9, 22, 4, 30, 0) })
			expect(await runsAfter(target.world, 2)).toEqual([{ job: 'nightly', notes: 1 }, { job: 'halfPast', notes: 1 }])
			await target.testEnv.scheduled({ scheduledTime: Date.UTC(2026, 9, 22, 4, 31, 0) })
			expect(await runsAfter(target.world, 3)).toHaveLength(2)
		})
	})
})

describe('the migrations', () => {
	test('apply when the object first boots; a second instance over the same database applies nothing', async () => {
		await keepingProcessEnvironment(async () => {
			const files = await createTestEnv({ bindings: { FILES: 'r2' } })
			deployed.push(files)
			const served = notesApp({ runs: [] })
			const migrations = await applicationMigrations(FIXTURE_ROOT)
			createContractWorker(() => Promise.resolve({ default: served.implementation }), { migrations })
			const env = { ...variablesOf(served), IAM: iamBinding(served), [CLOUDFLARE_FILES_BINDING]: files.env['FILES'] }
			const database = new BunDatabase(':memory:')
			const instance = (): ApplicationState => ({
				storage: bunSqliteStorage(database),
				blockConcurrencyWhile: (callback) => callback(),
				waitUntil: () => {},
			})
			const ledger = () =>
				database.query<{ bundle: string; name: string; applied_at: string }, []>(
					'select bundle, name, applied_at from fabrika_migrations order by bundle, name',
				).all()
			const health = () => new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } })

			expect((await new FabrikaApplication(instance(), env).fetch(health())).status).toBe(200)
			const applied = ledger()
			expect(applied.map((row) => `${row.bundle}/${row.name}`)).toContain('app/20261022120000_notes.sql')
			expect(applied.some((row) => row.bundle === 'fabrika')).toBe(true)

			expect((await new FabrikaApplication(instance(), env).fetch(health())).status).toBe(200)
			expect(ledger()).toEqual(applied)
		})
	})

	test('fabrika app build bundles every .sql file of db/migrations, by name, into the module the entry imports', async () => {
		expect((await applicationMigrations(FIXTURE_ROOT)).map((migration) => migration.name)).toEqual(['20261022120000_notes.sql'])
		expect(await applicationMigrations(join(FIXTURE_ROOT, 'src'))).toEqual([])
		const root = mkdtempSync(join(tmpdir(), 'fabrika-cf-build-'))
		try {
			mkdirSync(join(root, 'db', 'migrations'), { recursive: true })
			writeFileSync(join(root, 'db', 'migrations', '0002_b.sql'), "select 'b';\n")
			writeFileSync(join(root, 'db', 'migrations', '0001_a.sql'), 'select `a`;\n-- ${not interpolated}\n')
			writeFileSync(join(root, 'db', 'migrations', 'README.md'), 'not a migration')
			const entry = await writeGeneratedEntry(root, 'cloudflare')
			expect(readFileSync(entry, 'utf8')).toBe(generatedEntry('cloudflare'))
			const module: unknown = await import(join(root, GENERATED_MIGRATIONS_FILE))
			expect(typeof module === 'object' && module !== null ? Reflect.get(module, 'migrations') : null).toEqual([
				{ name: '0001_a.sql', sql: 'select `a`;\n-- ${not interpolated}\n' },
				{ name: '0002_b.sql', sql: "select 'b';\n" },
			])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe('the R2 file store', () => {
	async function store() {
		const testEnv = await createTestEnv({ bindings: { FILES: 'r2' } })
		deployed.push(testEnv)
		const files = r2FileObjectStore(testEnv.env['FILES'])
		if (files === undefined) {
			throw new Error('the R2 binding is no file store')
		}
		return files
	}
	const streamOf = (...chunks: Uint8Array[]) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(chunk)
				}
				controller.close()
			},
		})
	const bytesOf = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer())

	test('writes once, reads with its version, and reads a version only while it holds', async () => {
		const files = await store()
		const text = new TextEncoder().encode('hello')
		expect(await files.write('a', streamOf(text), { contentType: 'text/plain', maxBytes: 16 })).toEqual({ size: 5, contentType: 'text/plain' })
		const read = await files.read('a')
		if (read === null) {
			throw new Error('nothing stored')
		}
		expect({ size: read.size, contentType: read.contentType }).toEqual({ size: 5, contentType: 'text/plain' })
		expect(await bytesOf(read.body)).toEqual(text)
		const version = await files.readVersion('a', read.version)
		expect(version === null ? null : await bytesOf(version.body)).toEqual(text)
		expect(await files.readVersion('a', `${read.version}0`)).toBeNull()
		expect(await files.read('missing')).toBeNull()

		const again = files.write('a', streamOf(new TextEncoder().encode('other')), { contentType: 'text/plain', maxBytes: 16 })
		await expect(again).rejects.toBeInstanceOf(ObjectExistsError)
		const kept = await files.read('a')
		expect(kept === null ? null : await bytesOf(kept.body)).toEqual(text)

		await files.delete('a')
		await files.delete('a')
		expect(await files.read('a')).toBeNull()
	})

	test('stops past maxBytes and keeps nothing', async () => {
		const files = await store()
		const written = files.write('big', streamOf(new Uint8Array(10), new Uint8Array(10)), { contentType: 'text/plain', maxBytes: 15 })
		await expect(written).rejects.toBeInstanceOf(ObjectTooLargeError)
		expect(await files.read('big')).toBeNull()
	})

	test('a body longer than a part goes up in parts and reads back whole', async () => {
		const files = await store()
		const chunk = new Uint8Array(1024 * 1024).map((_, index) => index % 251)
		const chunks = Array.from({ length: Math.ceil((2 * R2_PART_BYTES + 10) / chunk.byteLength) }, () => chunk)
		const size = chunks.length * chunk.byteLength
		expect(await files.write('parts', streamOf(...chunks), { contentType: 'text/plain', maxBytes: size })).toEqual({ size, contentType: 'text/plain' })
		const read = await files.read('parts')
		expect(read?.size).toBe(size)
		const bytes = read === null ? new Uint8Array() : await bytesOf(read.body)
		expect(bytes.byteLength).toBe(size)
		expect(bytes.subarray(R2_PART_BYTES, R2_PART_BYTES + 16)).toEqual(chunk.subarray(0, 16))
	})
})

describe('boot on SQLite', () => {
	const Title = z.strictObject({ title: z.string() })
	const Titles = z.strictObject({ titles: z.array(z.string()) })

	test('refuses a site that declares raw SQL', () => {
		const raw = notesKit.group({ callers: ['human'] }, (r) => ({
			titles: r.query({ output: Titles, access: { action: 'notes.read', over: 'workspace' }, sql: 'read' })
				.handle(async ({ ctx }) => ({ titles: (await ctx.sql(Title)`select title from notes`).map((row) => row.title) })),
		}))
		const implementation = serve(notesKit.contract((c) => ({ api: c.rpc('/api', { raw }) })), { database: scoped(tables) })
		expect(() =>
			boot(implementation, { environment: environment(frameworkEnvFor(implementation)), iam: keySource, database: openSqlite(bunSqliteStorage()) })
		).toThrow("'api.raw.titles' declares sql: 'read'; ctx.sql runs only on Postgres")
	})

	test('refuses a file kind that scans', () => {
		const contract = notesKit.contract((c) => ({
			health: c.health('/healthz'),
			files: { documents: c.files({ maxBytes: 4096, types: ['application/pdf'], scan: true }) },
		}))
		const implementation = serve(contract, { database: scoped(tables) })
		expect(compileContract(contract, tables).fileKinds?.['documents']?.scan).toBe(true)
		let refusal: unknown = null
		try {
			boot(implementation, { environment: environment(frameworkEnvFor(implementation)), iam: keySource, database: openSqlite(bunSqliteStorage()) })
		} catch (error) {
			refusal = error
		}
		expect(refusal).toBeInstanceOf(BootError)
		expect(refusal instanceof BootError ? refusal.problems : []).toContain(
			"files 'documents' declares scan: true; no malware scanner runs on Cloudflare, so a scanning file kind is not served there",
		)
	})
})
