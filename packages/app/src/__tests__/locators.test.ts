// The locators `implement` generates from the table policies, on a REAL Postgres: `on`, `in` and `over` resolve where
// an object lies from the database on every request, so a grant on a container reaches what is inside it today, and
// a moved object's next Ref carries its new chain. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/app
//
// The file gets its own application schema `app_<id>`. The URL is a credential: it is never logged.

import type { ContractApp } from '@fabrika/app/implement'
import { applicationSchema, Database } from '@fabrika/db'
import { generateSchema } from '@fabrika/db/codegen'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { bootApp, errorType, grant, resultOf, send, type Sent, token } from './fixtures/implement/harness'
import { migration } from './fixtures/scoped-organizations/migration'
import { organizationsApp } from './fixtures/scoped-organizations/src/app'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`locators.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `locators-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
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

/** A note written outside the application. */
async function seedNote(workspace: string, organization: string, title: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, organization_id, title) values ($1, $2, $3, $4)`, [id, workspace, organization, title])
	)
	return id
}

async function moveNote(id: string, workspace: string): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.notes set workspace_id = $1 where id = $2`, [workspace, id]))
}

/** The composite foreign key moves the workspace's notes with it. */
async function moveWorkspace(workspace: string, organization: string): Promise<void> {
	await admin((sql) => sql.unsafe(`update ${schema}.workspaces set organization_id = $1 where id = $2`, [organization, workspace]))
}

const scope = (type: 'organization' | 'workspace' | 'note', value: string) => ({ type, value })

/** An editor (read and write) in each of `scopes`. */
function editorIn(...scopes: { readonly type: string; readonly value: string }[]): Promise<string> {
	return token('user', scopes.flatMap((held) => [grant('notes.read', held), grant('notes.write', held)]))
}

function idsOf(sent: Sent): string[] {
	const listed = resultOf(sent)
	return typeof listed === 'object' && listed !== null && 'items' in listed && Array.isArray(listed.items)
		? listed.items.map((item: { readonly id: string }) => item.id)
		: []
}

async function list(as: string): Promise<string[]> {
	return idsOf(await send(app, '/api/notes.list', { token: as, body: {} }))
}

function where(as: string, id: string): Promise<Sent> {
	return send(app, '/api/notes.where', { token: as, body: { id } })
}

function create(as: string, workspaceId: string, title: string): Promise<Sent> {
	return send(app, '/api/notes.create', { token: as, body: { workspaceId, title } })
}

async function notesTitled(title: string): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.notes where title = $1`, [title]))
	return Number(row?.n)
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) =>
		sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${migration}
		insert into workspaces (id, organization_id) values ('wa1', 'oA'), ('wa2', 'oA'), ('wb1', 'oB'), ('wm', 'oA');`)
	)
	database = Database.postgres({ url, schema, max: 2 })
	app = bootApp(organizationsApp(), { database })
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('locators generated from the table policies', () => {
	test('the fixture types are what codegen writes for its migration', async () => {
		const committed = await Bun.file(join(import.meta.dir, 'fixtures', 'scoped-organizations', 'src', 'db', 'schema.generated.ts')).text()
		expect(await generateSchema(url, schema)).toBe(committed)
	})

	test('on: a note of another workspace or organization is 404; a grant on its organization reaches it', async () => {
		const other = await seedNote('wb1', 'oB', 'theirs')
		for (const caller of [await editorIn(scope('workspace', 'wa1')), await editorIn(scope('organization', 'oA'))]) {
			const sent = await where(caller, other)
			expect(sent.status).toBe(404)
			expect(errorType(sent)).toBe('not_found')
		}
		expect(resultOf(await where(await editorIn(scope('organization', 'oB')), other))).toEqual({ id: other, workspace: 'wb1', organization: 'oB' })
	})

	test('over: a grant on an organization lists the notes of its workspaces, and only those', async () => {
		const inA1 = await seedNote('wa1', 'oA', 'a1')
		const inA2 = await seedNote('wa2', 'oA', 'a2')
		const inB1 = await seedNote('wb1', 'oB', 'b1')
		const organizationA = await list(await editorIn(scope('organization', 'oA')))
		expect(organizationA).toEqual(expect.arrayContaining([inA1, inA2]))
		expect(organizationA).not.toContain(inB1)
		const workspaceA1 = await list(await editorIn(scope('workspace', 'wa1')))
		expect(workspaceA1).toContain(inA1)
		expect(workspaceA1).not.toContain(inA2)
		expect(await list(await editorIn(scope('workspace', 'wb1'), scope('organization', 'oA')))).toEqual(expect.arrayContaining([inA1, inA2, inB1]))
	})

	test('over: an organization without workspaces lists nothing; a grant in no workspace or organization is 403', async () => {
		expect(await list(await editorIn(scope('organization', 'oEmpty')))).toEqual([])
		const sent = await send(app, '/api/notes.list', { token: await editorIn(scope('note', Bun.randomUUIDv7())), body: {} })
		expect(sent.status).toBe(403)
	})

	test('in: a grant on the organization creates in its workspace, and the Ref carries the organization', async () => {
		const created = resultOf(await create(await editorIn(scope('organization', 'oA')), 'wa1', 'by the organization'))
		expect(created).toMatchObject({ workspace: 'wa1', organization: 'oA' })
		const [row] = await admin((sql) => sql.unsafe(`select workspace_id, organization_id from ${schema}.notes where title = 'by the organization'`))
		expect(row).toEqual({ workspace_id: 'wa1', organization_id: 'oA' })
	})

	test('in: another organization’s workspace is 403, and a missing one is 404 only to a caller who holds it directly', async () => {
		const organizationA = await editorIn(scope('organization', 'oA'))
		expect((await create(organizationA, 'wb1', 'intruder')).status).toBe(403)
		expect((await create(organizationA, 'w-missing', 'intruder')).status).toBe(403)
		expect((await create(await editorIn(scope('workspace', 'w-missing')), 'w-missing', 'intruder')).status).toBe(404)
		expect(await notesTitled('intruder')).toBe(0)
	})

	test('a moved note’s Ref carries its new workspace: the old workspace loses it, the new one reaches it', async () => {
		const id = await seedNote('wa1', 'oA', 'moving note')
		await moveNote(id, 'wa2')
		expect(resultOf(await where(await editorIn(scope('workspace', 'wa2')), id))).toEqual({ id, workspace: 'wa2', organization: 'oA' })
		expect((await where(await editorIn(scope('workspace', 'wa1')), id)).status).toBe(404)
	})

	test('a moved workspace takes its notes to the new organization, for every access form', async () => {
		const id = await seedNote('wm', 'oA', 'moving workspace')
		await moveWorkspace('wm', 'oB')
		const organizationA = await editorIn(scope('organization', 'oA'))
		const organizationB = await editorIn(scope('organization', 'oB'))
		expect(resultOf(await where(organizationB, id))).toEqual({ id, workspace: 'wm', organization: 'oB' })
		expect((await where(organizationA, id)).status).toBe(404)
		expect(await list(organizationB)).toContain(id)
		expect(await list(organizationA)).not.toContain(id)
		expect(resultOf(await create(organizationB, 'wm', 'after the move'))).toMatchObject({ workspace: 'wm', organization: 'oB' })
		expect((await create(organizationA, 'wm', 'stale organization')).status).toBe(403)
		expect(await notesTitled('stale organization')).toBe(0)
	})
})
