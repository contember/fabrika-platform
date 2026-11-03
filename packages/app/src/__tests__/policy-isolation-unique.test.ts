// The generated insert case of a child table whose integer column is part of a UNIQUE key with its parent: the case adds
// a row under the seeded parent, beside the seeded row, so the sample of that column must differ from the seeded one. A
// column unique on its own already holds the migration's row; a bounded CHECK on a column unique within the parent, on
// one no unique index covers, and a small numeric stay satisfied however many cases run. On SQLite always, on Postgres when FABRIKA_TEST_POSTGRES_URL is set (it skips cleanly otherwise).

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { policyIsolationKit } from '@fabrika/app/testing/isolation'
import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase as postgresDatabase } from '@fabrika/db/testing'
import { testDatabase as sqliteDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const vocabulary = defineVocabulary({
	app: 'attachments',
	dimensions: { attachment: {} },
	actions: { 'attachments.read': 'Read attachments', 'attachments.write': 'Upload attachments' },
	roles: { editor: { grants: ['attachments.read', 'attachments.write'] } },
})

interface DB {
	attachments: { id: string; name: string }
	attachment_versions: {
		id: string
		attachment_id: string
		number: number
		position: number
		serial: number
		rating: number
		weight: string
		size: number
		label: string
	}
}

const columns: TypedColumnList<DB> = {
	attachments: { columns: ['id', 'name'], foreignKeys: [] },
	attachment_versions: {
		columns: ['id', 'attachment_id', 'number', 'position', 'serial', 'rating', 'weight', 'size', 'label'],
		foreignKeys: [{ columns: ['attachment_id'], table: 'attachments', references: ['id'] }],
	},
}

const tables = defineTables(vocabulary, columns)({
	attachments: {
		scope: { dimension: 'attachment', key: 'id' },
		actions: { read: 'attachments.read', insert: 'attachments.write' },
		insert: ['name'],
	},
	attachment_versions: {
		scope: { child: 'attachments' },
		actions: { read: 'attachments.read', insert: 'attachments.write' },
		insert: ['number', 'position', 'serial', 'rating', 'weight', 'size', 'label'],
	},
})

const contract = defineApp(vocabulary, tables).contract(() => ({}))

/**
 * The same schema in each dialect: a version's number is unique within its attachment, and positive; so is its position,
 * which lies between 1 and 5; its serial is unique across the table, which the migration's row already holds 1 of; its
 * rating lies between 1 and 5.
 */
const migrations = {
	postgres: `
create table attachments (id uuid primary key, name text not null);
create table attachment_versions (
	id uuid primary key,
	attachment_id uuid not null references attachments (id),
	number integer not null check (number > 0),
	position smallint not null check (position between 1 and 5),
	serial integer not null unique,
	rating smallint not null check (rating between 1 and 5),
	weight numeric(2, 1) not null,
	size bigint not null,
	label text not null,
	unique (attachment_id, number),
	unique (attachment_id, position)
);
insert into attachments values ('00000000-0000-4000-8000-000000000001', 'imported');
insert into attachment_versions values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1, 1, 1, 1, 1.0, 1, 'imported');
`,
	sqlite: `
CREATE TABLE attachments (id UUID PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE attachment_versions (
	id UUID PRIMARY KEY,
	attachment_id UUID NOT NULL REFERENCES attachments (id),
	number INTEGER NOT NULL CHECK (number > 0),
	position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 5),
	serial INTEGER NOT NULL UNIQUE,
	rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
	weight REAL NOT NULL CHECK (weight < 10),
	size BIGINT NOT NULL,
	label TEXT NOT NULL,
	UNIQUE (attachment_id, number),
	UNIQUE (attachment_id, position)
);
INSERT INTO attachments VALUES ('00000000-0000-4000-8000-000000000001', 'imported');
INSERT INTO attachment_versions VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 1, 1, 1, 1, 1.0, 1, 'imported');
`,
}

const directory = mkdtempSync(join(tmpdir(), 'fabrika-policy-isolation-unique-'))
for (const dialect of ['postgres', 'sqlite'] as const) {
	mkdirSync(join(directory, dialect))
	writeFileSync(join(directory, dialect, '20261103120000_attachments.sql'), migrations[dialect])
}
const label = 'policy-isolation-unique.test.ts'
const sqlite = await sqliteDatabase({ migrations: join(directory, 'sqlite'), label })
const postgres = await postgresDatabase({ migrations: join(directory, 'postgres'), label })

afterAll(async () => {
	await sqlite.close()
	await postgres?.close()
	rmSync(directory, { recursive: true, force: true })
})

for (const [dialect, database] of [['SQLite', sqlite], ['Postgres', postgres]] as const) {
	describe.skipIf(database === null)(`the generated insert case of a UNIQUE key over an integer column, on ${dialect}`, () => {
		test('a row inserted under the seeded parent takes a number and a serial of its own, case after case', async () => {
			if (database === null) return
			const kit = policyIsolationKit(contract, tables, 'attachment_versions', database)
			const statuses: number[] = []
			for (let round = 0; round < 12; round++) statuses.push((await kit.insert('own')).status)
			expect(statuses).toEqual(Array.from({ length: 12 }, () => 200))
			expect((await kit.insert('other')).status).toBe(403)
		})
	})
}
