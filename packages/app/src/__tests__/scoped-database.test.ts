// `implement` over `@fabrika/db` on a REAL Postgres: boot connects the scoped layer, the access forms mint request-bound
// capabilities, and the data layer refuses every capability that is not the current request's own. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/app
//
// The file gets its own application schema `app_<id>`. The URL is a credential: it is never logged.

import { serveContract } from '@fabrika/app/bun'
import { BootError, type ContractApp } from '@fabrika/app/implement'
import { applicationSchema, type CapabilityAuthority, Database, type Ref, scoped } from '@fabrika/db'
import { bindScopedDatabase } from '@fabrika/db/framework'
import { openPostgres } from '@fabrika/db/postgres'
import { defineStore } from '@fabrika/db/testing'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createCapabilityIssuer } from '../implement/capability'
import { implement } from '../implement/implement'
import {
	bootApp,
	errorType,
	frameworkEnvFor,
	grant,
	keepingProcessEnvironment,
	PROXY_SECRET,
	resultOf,
	send,
	token,
} from './fixtures/implement/harness'
import { contract } from './fixtures/scoped-notes/fabrika.contract'
import { migration } from './fixtures/scoped-notes/migration'
import { type Hooks, scopedNotesApp } from './fixtures/scoped-notes/src/app'
import { tables } from './fixtures/scoped-notes/src/db/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`scoped-database.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `scoped-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const W1 = { type: 'workspace', value: 'w1' }
const W2 = { type: 'workspace', value: 'w2' }

/** The pause points of the fixture's handlers; each test sets the ones it needs. */
const hooks: { beforeRead: Hooks['beforeRead']; whileKept: Hooks['whileKept'] } = {
	beforeRead: () => Promise.resolve(),
	whileKept: () => Promise.resolve(),
}
let database: Database
let app: ContractApp

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** A note written outside the application, as another workspace's user would have created it. */
async function seedNote(workspace: string, title: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, $2, $3, 'user-9', 1)`, [id, workspace, title])
	)
	return id
}

async function editorOf(...workspaces: { readonly type: string; readonly value: string }[]): Promise<string> {
	return token('user', workspaces.flatMap((scope) => [grant('notes.read', scope), grant('notes.write', scope)]))
}

/** The fixed 500 envelope and the one log line it leaves; the reason stays on the server. */
async function refusedCapability(work: () => Promise<{ readonly status: number; readonly body: unknown }>): Promise<string> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const sent = await work()
		expect(sent.status).toBe(500)
		expect(sent.body).toEqual({ error: { type: 'internal', message: 'Internal error' } })
		return log.mock.calls.map((call) => String(call[0])).join('\n')
	} finally {
		log.mockRestore()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await definePostgresApplicationMigrations({ appId, directory: '/unused' }).migrate(url, [{ name: '20261011120000_notes.sql', sql: migration }])
	database = openPostgres({ url: applicationRuntimeUrl(url, appId), schema, max: 2 })
	app = bootApp(scopedNotesApp(hooks), { database })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await dropApplicationDatabase(url, appId)
})

describe.skipIf(!hasPostgres)('implement over @fabrika/db on Postgres', () => {
	test('create stamps the workspace and the principal from the capabilities, and answers the key only', async () => {
		const sent = await send(app, '/api/notes.create', { token: await editorOf(W1), body: { workspaceId: 'w1', title: 'First' } })
		const created = resultOf(sent)
		const id = typeof created === 'object' && created !== null && 'id' in created ? String(created.id) : ''
		const [row] = await admin((sql) => sql.unsafe(`select workspace_id, title, created_by, version from ${schema}.notes where id = $1`, [id]))
		expect(row).toEqual({ workspace_id: 'w1', title: 'First', created_by: 'user-1', version: 1 })
		expect(resultOf(await send(app, '/api/notes.get', { token: await editorOf(W1), body: { id } }))).toEqual({ id, title: 'First' })
	})

	test('a list over the caller’s workspaces never shows another workspace’s note', async () => {
		const own = await seedNote('w1', 'mine')
		const other = await seedNote('w2', 'theirs')
		const listed = resultOf(await send(app, '/api/notes.list', { token: await editorOf(W1), body: {} }))
		const ids = typeof listed === 'object' && listed !== null && 'items' in listed && Array.isArray(listed.items)
			? listed.items.map((item: { readonly id: string }) => item.id)
			: []
		expect(ids).toContain(own)
		expect(ids).not.toContain(other)
	})

	test('a note of another workspace is 404 and a create in another workspace is 403, without a query for either', async () => {
		const other = await seedNote('w2', 'not yours')
		const read = await send(app, '/api/notes.get', { token: await editorOf(W1), body: { id: other } })
		expect(read.status).toBe(404)
		expect(errorType(read)).toBe('not_found')
		const missing = await send(app, '/api/notes.get', { token: await editorOf(W1), body: { id: Bun.randomUUIDv7() } })
		expect(missing.status).toBe(404)
		const write = await send(app, '/api/notes.create', { token: await editorOf(W1), body: { workspaceId: 'w2', title: 'intruder' } })
		expect(write.status).toBe(403)
		const [count] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.notes where title = 'intruder'`))
		expect(count).toEqual({ n: 0 })
	})

	test('a Ref from another live request is refused by the data layer', async () => {
		const id = await seedNote('w1', 'held')
		let release: () => void = () => {}
		let kept: () => void = () => {}
		const keptNow = new Promise<void>((resolve) => {
			kept = resolve
		})
		hooks.whileKept = () =>
			new Promise<void>((resolve) => {
				release = resolve
				kept()
			})
		try {
			const holding = send(app, '/api/notes.keep', { token: await editorOf(W1), body: { id } })
			await keptNow
			const log = await refusedCapability(async () => send(app, '/api/notes.reuse', { token: await editorOf(W2), body: {} }))
			expect(log).toContain('capability_refused: foreign_work')
			release()
			expect(resultOf(await holding)).toEqual({ kept: true })
		} finally {
			hooks.whileKept = () => Promise.resolve()
		}
	})

	test('a Ref after its request ended is refused by the data layer', async () => {
		const id = await seedNote('w1', 'expired')
		expect(resultOf(await send(app, '/api/notes.keep', { token: await editorOf(W1), body: { id } }))).toEqual({ kept: true })
		const log = await refusedCapability(async () => send(app, '/api/notes.reuse', { token: await editorOf(W1), body: {} }))
		expect(log).toContain('capability_refused: ended')
	})

	test('a note moved after its Ref was minted is 404: the Ref carries the old workspace, and a fresh one the new', async () => {
		const id = await seedNote('w1', 'moving')
		hooks.beforeRead = (target) => admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = 'w2' where id = $1`, [target])).then(() => {})
		try {
			const stale = await send(app, '/api/notes.get', { token: await editorOf(W1, W2), body: { id } })
			expect(stale.status).toBe(404)
		} finally {
			hooks.beforeRead = () => Promise.resolve()
		}
		expect(resultOf(await send(app, '/api/notes.get', { token: await editorOf(W2), body: { id } }))).toEqual({ id, title: 'moving' })
		expect((await send(app, '/api/notes.get', { token: await editorOf(W1), body: { id } })).status).toBe(404)
	})

	test('a wrapper around the database gets no connection, so a second layer the application creates stays unconnected', async () => {
		const foreign = await seedNote('w2', 'foreign')
		const rogue = scoped(tables)
		const rogueNotes = defineStore(rogue, 'notes', (t) => ({ get: (note: Ref<'note', 'notes.read'>) => t.get(note) }))
		// An authority of the application's own over the runtime's: every Ref it is handed lies in w2.
		let runtimeAuthority: CapabilityAuthority | undefined
		const everyWorkspace: CapabilityAuthority = {
			resolve: (capability) => {
				if (runtimeAuthority === undefined) {
					throw new Error('the runtime has not booted')
				}
				const grant = runtimeAuthority.resolve(capability)
				return grant.kind === 'ref' ? { ...grant, chain: new Map([['workspace', 'w2']]) } : grant
			},
			row: () => {
				throw new Error('the test claims no row')
			},
			fence: () => null,
		}
		const received: unknown[] = []
		// The reviewed bypass: a connect callback that receives the framework's connection and connects the second layer.
		const connect = (runtime: { readonly database: unknown }): void => {
			received.push(runtime)
			const connectRogue: unknown = Reflect.get(rogue, 'connect')
			if (typeof connectRogue === 'function') {
				Reflect.apply(connectRogue, rogue, [{ database: runtime.database, capabilities: everyWorkspace }])
			}
		}
		const wrapper = { tables: rogue.tables, locate: () => Promise.resolve(new Map([['workspace', 'w1']])), connect }
		const wrapped = bootApp(
			implement(contract, {
				database: wrapper,
				deps: (_env, { capabilities }) => {
					runtimeAuthority = capabilities
					return {}
				},
				handlers: () => ({
					api: {
						notes: {
							list: () => ({ items: [] }),
							get: async ({ ctx }) => {
								const note = await rogueNotes.get(ctx.target)
								return { id: note.id, title: note.title }
							},
							create: () => ({ id: foreign }),
							keep: () => ({ kept: false }),
							reuse: () => ({ id: foreign, title: '' }),
						},
					},
				}),
			}),
			{ database },
		)
		const log = await refusedCapability(async () => send(wrapped, '/api/notes.get', { token: await editorOf(W1), body: { id: foreign } }))
		expect(received).toEqual([])
		expect(log).toContain('capability_refused: layer_unbound')
	})
})

describe('boot binds the data layer once', () => {
	test('without a database connection, an application on @fabrika/db does not boot', () => {
		expect(() => bootApp(scopedNotesApp(hooks, scoped(tables)))).toThrow(
			'the application uses @fabrika/db, which runs on Bun with Postgres, and the runtime adapter supplies no database connection',
		)
	})

	test('a layer bound before boot (an application import of @fabrika/db/framework) makes boot fail', () => {
		const connection = openPostgres({ url: 'postgres://user:secret@127.0.0.1:1/none', schema: 'app_notes' })
		const early = scoped(tables)
		bindScopedDatabase(early, {
			database: connection,
			capabilities: {
				resolve: () => ({ kind: 'within', dimension: 'workspace', action: 'notes.read', principal: 'x', values: 'all', containers: [] }),
				row: () => {
					throw new Error('the test claims no row')
				},
				fence: () => null,
			},
		})
		expect(() => bootApp(scopedNotesApp(hooks, early), { database: connection })).toThrow(BootError)
		expect(() => bootApp(scopedNotesApp(hooks, early), { database: connection })).toThrow('the data layer was bound before boot')
	})

	test('a structural copy of scoped(tables) is not bound and does not boot', () => {
		const connection = openPostgres({ url: 'postgres://user:secret@127.0.0.1:1/none', schema: 'app_notes' })
		const real = scoped(tables)
		for (const copy of [{ ...real }, { tables: real.tables }]) {
			expect(() => bootApp(scopedNotesApp(hooks, copy), { database: connection })).toThrow('not a copy or a wrapper of it')
		}
	})

	test('serveContract refuses without FABRIKA_APP_DATABASE_URL and names no value', async () => {
		await keepingProcessEnvironment(async () => {
			const application = scopedNotesApp(hooks, scoped(tables))
			const env = { ...frameworkEnvFor(application), FABRIKA_APP_ID: 'notes', PORT: '0' }
			const served = serveContract(() => Promise.resolve({ default: application }), env)
			await expect(served).rejects.toThrow('FABRIKA_APP_DATABASE_URL is not set')
		})
	})

	test('serveContract refuses a pool size the platform could not have written', async () => {
		for (const connections of ['0', '101', '2.5', ' 4', '']) {
			await keepingProcessEnvironment(async () => {
				const application = scopedNotesApp(hooks, scoped(tables))
				const env = {
					...frameworkEnvFor(application),
					FABRIKA_APP_ID: 'notes',
					FABRIKA_APP_RUNTIME_DATABASE_URL: 'postgres://run_notes:secret@127.0.0.1:1/none',
					FABRIKA_APP_DATABASE_CONNECTIONS: connections,
					PORT: '0',
				}
				const served = serveContract(() => Promise.resolve({ default: application }), env)
				await expect(served).rejects.toThrow(
					`FABRIKA_APP_DATABASE_CONNECTIONS '${connections}' is not a number of connections (allowed: 1 to 100)`,
				)
			})
		}
	})

	test.skipIf(!hasPostgres)('serveContract opens the application schema from the framework variables and connects it', async () => {
		await keepingProcessEnvironment(async () => {
			const served = scoped(tables)
			const application = scopedNotesApp(hooks, served)
			const env = {
				...frameworkEnvFor(application),
				FABRIKA_APP_ID: appId,
				FABRIKA_APP_RUNTIME_DATABASE_URL: applicationRuntimeUrl(url, appId),
				FABRIKA_PROXY_SECRET: PROXY_SECRET,
				PORT: '0',
			}
			const server = await serveContract(() => Promise.resolve({ default: application }), env)
			try {
				expect((await fetch(`http://localhost:${server.port}/healthz`)).status).toBe(200)
				expect(() => bindScopedDatabase(served, { database, capabilities: createCapabilityIssuer().authority })).toThrow('already connected')
			} finally {
				await server.stop()
			}
		})
	})
})
