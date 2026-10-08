// The framework's own writes against a REAL Postgres: a form's inbox append and the webhook tables of
// `@fabrika/db/migrations`. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see postgres.test.ts).

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../database'
import { QueryRefusedError } from '../errors'
import { frameworkTablesOf } from '../framework'
import { FRAMEWORK_MIGRATIONS } from '../migrations'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { migration } from './fixtures/schema'
import { connected } from './fixtures/stores'
import { tables } from './fixtures/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`framework-tables.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `fw_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let database: Database
let framework: ReturnType<typeof frameworkTablesOf>

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await sql.unsafe(`set search_path to ${schema}; ${framework} ${migration}`)
	})
	database = Database.postgres({ url: url ?? '', schema, max: 4 })
	const layer = connected(tables, { database, capabilities: new TestAuthority('user:alice') }).database
	framework = frameworkTablesOf(layer)
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

const W1 = { type: 'workspace', value: 'w1' }

describe('the inbox check, before anything is bound', () => {
	test('names a form without an inbox and a field that is not a column', () => {
		const unbound = frameworkTablesOf(
			connected(tables, { database: Database.fromDialect(new RecordingDialect()), capabilities: new TestAuthority('x') }).database,
		)
		expect(unbound.inboxProblems('contact', ['id', 'email', 'body'])).toEqual([])
		expect(unbound.inboxProblems('contact', ['email', 'phone'])).toEqual([
			"the input field 'phone' of 'contact' is not a column of its inbox contact_messages",
		])
		expect(unbound.inboxProblems('feedback', [])).toEqual([
			"no table in src/db/tables.ts is the inbox of 'feedback' (scope: { inbox: 'feedback', read })",
		])
	})

	test('refuses a value that is not one of scoped(tables)', () => {
		expect(() => frameworkTablesOf({ tables: {} })).toThrow('not a data layer scoped(tables) created')
	})
})

describe.skipIf(!hasPostgres)('the framework tables on Postgres', () => {
	test('an inbox append writes one row of the declared columns and answers nothing', async () => {
		await framework.appendToInbox('contact', { id: 'm1', email: 'a@example.com', body: 'hello' })
		const rows = await admin((sql) => sql.unsafe(`select id, email, body from ${schema}.contact_messages`))
		expect([...rows]).toEqual([{ id: 'm1', email: 'a@example.com', body: 'hello' }])
	})

	test('an inbox append refuses an undeclared column and a value the layer cannot bind', async () => {
		await expect(framework.appendToInbox('contact', { id: 'm2', email: 'a@example.com', body: 'x', admin: true })).rejects.toBeInstanceOf(
			QueryRefusedError,
		)
		await expect(framework.appendToInbox('contact', { id: 'm3', email: ['a', 'b'], body: 'x' })).rejects.toBeInstanceOf(QueryRefusedError)
		await expect(framework.appendToInbox('feedback', { id: 'm4' })).rejects.toBeInstanceOf(QueryRefusedError)
	})

	test('a binding is found only under its own webhook, and removed only from its own scope', async () => {
		const binding = { id: 'b1', webhook: 'github', scope: W1, account: 'installation:42', secret: 's3cret' }
		await framework.webhooks.createBinding({ ...binding, createdBy: 'user-1', createdAt: 1 })
		expect(await framework.webhooks.binding('github', 'b1')).toEqual(binding)
		expect(await framework.webhooks.binding('other', 'b1')).toBeNull()
		expect(await framework.webhooks.binding('github', 'missing')).toBeNull()
		expect(await framework.webhooks.removeBinding('github', 'b1', { type: 'workspace', value: 'w2' })).toBe(false)
		expect(await framework.webhooks.removeBinding('github', 'b1', W1)).toBe(true)
		expect(await framework.webhooks.binding('github', 'b1')).toBeNull()
	})

	test('a delivery id is recorded once per binding, concurrent copies included, and can be forgotten', async () => {
		await framework.webhooks.createBinding({
			id: 'b2',
			webhook: 'github',
			scope: W1,
			account: 'repository:7',
			secret: 's',
			createdBy: 'u',
			createdAt: 1,
		})
		await framework.webhooks.createBinding({
			id: 'b3',
			webhook: 'github',
			scope: W1,
			account: 'repository:7',
			secret: 's',
			createdBy: 'u',
			createdAt: 1,
		})
		const copies = await Promise.all([1, 2, 3, 4].map(() => framework.webhooks.recordDelivery('b2', 'd1', 10)))
		expect(copies.filter((recorded) => recorded)).toHaveLength(1)
		expect(await framework.webhooks.recordDelivery('b3', 'd1', 10)).toBe(true)
		await framework.webhooks.forgetDelivery('b2', 'd1')
		expect(await framework.webhooks.recordDelivery('b2', 'd1', 11)).toBe(true)
	})
})
