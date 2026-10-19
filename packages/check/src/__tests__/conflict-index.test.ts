// `on-conflict-index`: the columns an insert's `onConflict` names are the column set of a unique index a migration
// creates, as Postgres requires; a partial index, an expression and a dropped index do not count.

import { describe, expect, test } from 'bun:test'
import type { Finding } from '../finding'
import { checkConflictIndexes, type ConflictInsert } from '../rules/migrations'

const finding: Finding = { file: 'src/a.ts', line: 1, column: 1, severity: 'refusal', rule: 'on-conflict-index', message: 'm', allowed: 'a' }
const insert = (table: string, ...columns: string[]): ConflictInsert => ({ table, columns, finding })

/** The findings of the inserts no migration of `sql` covers. */
const uncovered = (sql: string, inserts: readonly ConflictInsert[]): Finding[] =>
	checkConflictIndexes(new Map([['db/migrations/20261019120000_a.sql', sql]]), new Set(['unsubscribes', 'bookings']), inserts)

describe('the unique indexes an onConflict may name', () => {
	test('a primary key, a unique column, a unique constraint in any order, a later constraint and a unique index count', () => {
		const sql = [
			'CREATE TABLE unsubscribes (id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, campaign TEXT NOT NULL, CONSTRAINT pair UNIQUE (email, campaign));',
			'CREATE TABLE bookings (id UUID PRIMARY KEY, slot TEXT NOT NULL, name TEXT NOT NULL);',
			'ALTER TABLE bookings ADD CONSTRAINT bookings_slot UNIQUE (slot);',
			'CREATE UNIQUE INDEX bookings_name_slot ON bookings (name, slot);',
		].join('\n')
		const inserts = [
			insert('unsubscribes', 'id'),
			insert('unsubscribes', 'email'),
			insert('unsubscribes', 'campaign', 'email'),
			insert('bookings', 'slot'),
			insert('bookings', 'slot', 'name'),
		]
		expect(uncovered(sql, inserts)).toEqual([])
	})

	test('a plain, a partial or a dropped index, another column set and an expression do not', () => {
		const sql = [
			'CREATE TABLE unsubscribes (id UUID PRIMARY KEY, email TEXT NOT NULL, campaign TEXT NOT NULL);',
			'CREATE INDEX unsubscribes_email ON unsubscribes (email);',
			'CREATE UNIQUE INDEX unsubscribes_campaign ON unsubscribes (campaign) WHERE campaign IS NOT NULL;',
			'CREATE UNIQUE INDEX unsubscribes_pair ON unsubscribes (email, campaign);',
			'DROP INDEX unsubscribes_pair;',
			'CREATE UNIQUE INDEX unsubscribes_lower ON unsubscribes (lower(email));',
		].join('\n')
		const inserts = [insert('unsubscribes', 'email'), insert('unsubscribes', 'campaign'), insert('unsubscribes', 'email', 'campaign')]
		expect(uncovered(sql, inserts)).toHaveLength(3)
	})

	test('a receiver that is no declared table is not checked', () => {
		expect(uncovered('', [insert('outbox', 'id')])).toEqual([])
	})
})
