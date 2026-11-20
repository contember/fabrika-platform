// The isolation kits of an application whose vocabulary names a terminal's identification page: each probe contract
// keeps the application's SPA mounts, so the public mount that serves the page is still there when the probe is built.
// On SQLite, which needs no service.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { appPolicyIsolationKit, policyIsolationKit } from '@fabrika/app/testing/isolation'
import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const vocabulary = defineVocabulary({
	app: 'attendance',
	dimensions: { site: {} },
	actions: { 'attendance.read': 'Read attendance', 'attendance.record': 'Record attendance' },
	roles: { staff: { grants: ['attendance.read', 'attendance.record'] } },
	terminal: { identify: '/kiosk' },
})

interface DB {
	sites: { id: string; name: string }
	shifts: { id: string; label: string }
}

const columns: TypedColumnList<DB> = {
	sites: { columns: ['id', 'name'], foreignKeys: [] },
	shifts: { columns: ['id', 'label'], foreignKeys: [] },
}

const tables = defineTables(vocabulary, columns)({
	sites: { scope: { dimension: 'site', key: 'id' }, actions: { read: 'attendance.read', insert: 'attendance.record' }, insert: ['name'] },
	shifts: { scope: { app: 'the shift templates' }, actions: { read: 'attendance.read', insert: 'attendance.record' }, insert: ['label'] },
})

const contract = defineApp(vocabulary, tables).contract((c) => ({
	kiosk: c.spa('/kiosk', { dir: 'dist', access: { public: true } }),
	site: c.spa('/', { dir: 'dist', access: { member: true } }),
}))

const directory = mkdtempSync(join(tmpdir(), 'fabrika-policy-isolation-terminal-'))
writeFileSync(
	join(directory, '20261120120000_attendance.sql'),
	'CREATE TABLE sites (id UUID PRIMARY KEY, name TEXT NOT NULL);\nCREATE TABLE shifts (id UUID PRIMARY KEY, label TEXT NOT NULL);\n',
)
const database = await testDatabase({ migrations: directory, label: 'policy-isolation-terminal.test.ts' })

afterAll(async () => {
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

describe('the isolation kits of an application with a terminal identification page', () => {
	test('the kit of a dimension table builds its probe and reads only its own row', async () => {
		const kit = policyIsolationKit(contract, tables, 'sites', database)
		expect((await kit.get('own')).status).toBe(200)
		expect((await kit.get('other')).status).toBe(404)
	})

	test('the kit of an application table builds its probe, and only a global holder lists its rows', async () => {
		const kit = appPolicyIsolationKit(contract, tables, 'shifts', database)
		expect(await kit.list('global')).toEqual({ status: 200, rows: ['own'] })
		expect((await kit.list('scoped')).status).toBe(403)
	})
})
