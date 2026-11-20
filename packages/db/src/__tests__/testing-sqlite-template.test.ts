// `@fabrika/db/testing-sqlite`'s templates: a database migrated (and seeded) once, which every test database starts as
// a copy of. It needs no backend, so nothing here skips.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindScopedDatabase } from '../framework'
import { scoped } from '../store'
import { tableProbe, type TestDatabase, testDatabase, testDatabaseTemplate } from '../testing-sqlite'
import { TestAuthority } from './fixtures/authority'
import { tables } from './fixtures/tables'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-sqlite-template-'))
writeFileSync(join(migrations, '20261120120000_settings.sql'), 'create table settings (id text primary key, value text not null);')
const opened: TestDatabase[] = []
afterAll(async () => {
	for (const database of opened) await database.close()
	rmSync(migrations, { recursive: true, force: true })
})

/** A test database, closed after the file. */
async function open(options: Parameters<typeof testDatabase>[0]): Promise<TestDatabase> {
	const database = await testDatabase(options)
	opened.push(database)
	return database
}

/** The rows of `settings` in `database`, read through a layer bound to it. */
async function settingsIn(database: TestDatabase): Promise<string> {
	const authority = new TestAuthority()
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database: database.database, capabilities: authority })
	return tableProbe(layer, 'settings').count(authority.app('settings.read'))
}

describe('a test database template', () => {
	test('is migrated and seeded once; each copy starts with its seed, and a write to one reaches no other', async () => {
		const template = await testDatabaseTemplate({
			migrations,
			label: 'testing-sqlite-template.test.ts',
			seed: async (database) => {
				await database.seedRow(tables, 'settings', { value: 'base' })
			},
		})
		const first = await open({ migrations, label: 'first', template })
		const second = await open({ migrations, label: 'second', template })
		await first.seedRow(tables, 'settings', { value: 'only in the first' })
		expect(await settingsIn(first)).toBe('2')
		expect(await settingsIn(second)).toBe('1')
		expect(await settingsIn(await open({ migrations, label: 'third', template }))).toBe('1')
	})

	test('of other migrations is refused', async () => {
		const template = await testDatabaseTemplate({ migrations, label: 'testing-sqlite-template.test.ts' })
		const other = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-sqlite-template-other-'))
		try {
			writeFileSync(join(other, '20261120120000_settings.sql'), 'create table settings (id text primary key, value text);')
			await expect(testDatabase({ migrations: other, label: 'other.test.ts', template })).rejects.toThrow('migrated with other migrations')
		} finally {
			rmSync(other, { recursive: true, force: true })
		}
	})
})

describe('test databases of one process without a template', () => {
	test('each start empty, as copies of the first migration, and a changed migration is applied', async () => {
		const first = await open({ migrations, label: 'first' })
		await first.seedRow(tables, 'settings')
		expect(await settingsIn(first)).toBe('1')
		const second = await open({ migrations, label: 'second' })
		expect(await settingsIn(second)).toBe('0')

		const changed = mkdtempSync(join(tmpdir(), 'fabrika-db-testing-sqlite-template-changed-'))
		try {
			writeFileSync(
				join(changed, '20261120120000_settings.sql'),
				"create table settings (id text primary key, value text not null); insert into settings values ('preset', 'x');",
			)
			expect(await settingsIn(await open({ migrations: changed, label: 'third' }))).toBe('1')
		} finally {
			rmSync(changed, { recursive: true, force: true })
		}
	})
})
