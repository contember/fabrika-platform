// `access-view-key`: a table that names an access view has its key unique on its own (ADR-0076 section 1).

import { describe, expect, test } from 'bun:test'
import { type AccessKey, checkAccessViewKeys } from '../rules/migrations'

const MIGRATION = 'db/migrations/20261019120000_a.sql'
const keys: readonly AccessKey[] = [{ table: 'modules', key: 'id', views: ['published_modules'] }]

/** The tables of `keys` whose key no migration of `sql` makes unique on its own. */
const refused = (sql: string, checked: readonly AccessKey[] = keys): string[] =>
	checkAccessViewKeys(new Map([[MIGRATION, sql]]), checked).map((finding) => `${finding.file}:${finding.line}`)

describe('the key of a table that names an access view', () => {
	test('a primary key, a unique column and a later unique index count', () => {
		expect(refused('CREATE TABLE modules (id UUID PRIMARY KEY, title TEXT);')).toEqual([])
		expect(refused('CREATE TABLE modules (id UUID NOT NULL UNIQUE, title TEXT);')).toEqual([])
		expect(refused('CREATE TABLE modules (id UUID NOT NULL, title TEXT);\nCREATE UNIQUE INDEX modules_id ON modules (id);')).toEqual([])
	})

	test('no key, a composite key, a partial or a dropped index are refused at the table', () => {
		const sql = [
			'CREATE TABLE modules (id UUID NOT NULL, company_id UUID NOT NULL, PRIMARY KEY (company_id, id));',
			'CREATE UNIQUE INDEX modules_live ON modules (id) WHERE id IS NOT NULL;',
			'CREATE UNIQUE INDEX modules_id ON modules (id);',
			'DROP INDEX modules_id;',
		].join('\n')
		expect(refused(sql)).toEqual([`${MIGRATION}:1`])
	})

	test('a key added later, a renamed table or column that keeps it, and an unlogged table count', () => {
		expect(refused('CREATE TABLE modules (id UUID NOT NULL);\nALTER TABLE modules ADD PRIMARY KEY (id);')).toEqual([])
		expect(refused('CREATE TABLE mods (id UUID PRIMARY KEY);\nALTER TABLE mods RENAME TO modules;')).toEqual([])
		expect(refused('CREATE TABLE modules (old_id UUID PRIMARY KEY);\nALTER TABLE modules RENAME COLUMN old_id TO id;')).toEqual([])
		expect(refused('CREATE UNLOGGED TABLE modules (id UUID PRIMARY KEY);')).toEqual([])
	})

	test('a dropped key constraint, a recreated table without one and a renamed key column are refused', () => {
		expect(refused('CREATE TABLE modules (id UUID PRIMARY KEY);\nALTER TABLE modules DROP CONSTRAINT modules_pkey;')).toEqual([`${MIGRATION}:1`])
		expect(refused('CREATE TABLE modules (id UUID, CONSTRAINT one UNIQUE (id));\nALTER TABLE modules DROP CONSTRAINT one;')).toEqual([`${MIGRATION}:1`])
		expect(refused('CREATE TABLE modules (id UUID PRIMARY KEY);\nDROP TABLE modules;\nCREATE TABLE modules (id UUID);')).toEqual([`${MIGRATION}:3`])
		expect(refused('CREATE TABLE modules (id UUID PRIMARY KEY);\nALTER TABLE modules RENAME COLUMN id TO old_id;')).toEqual([`${MIGRATION}:1`])
	})

	test('a view as the target is not checked; a name no migration creates is refused at the policies', () => {
		expect(refused('CREATE VIEW modules AS SELECT 1 AS id;')).toEqual([])
		expect(refused('CREATE TABLE other (id UUID PRIMARY KEY);')).toEqual(['src/db/tables.ts:1'])
	})
})
