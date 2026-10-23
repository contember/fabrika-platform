// The rule of the application rows an endpoint access case seeds, which the checker reports from source and the test
// kit throws: no database.

import { describe, expect, test } from 'bun:test'
import type { TypedColumnList } from '../index'
import { defineTables } from '../policy'
import { applicationRowRefusalText, applicationRowsPlan } from '../tables'

interface DB {
	palettes: { id: string; code: string }
	shades: { id: string; palette_id: string; palette_code: string; name: string }
	threads: { id: string; pinned: string | null }
	posts: { id: string; thread_id: string; image: string }
	teams: { id: string; version: number }
}

const columns: TypedColumnList<DB> = {
	palettes: { columns: ['id', 'code'], foreignKeys: [] },
	shades: {
		columns: ['id', 'palette_id', 'palette_code', 'name'],
		foreignKeys: [{ columns: ['palette_id', 'palette_code'], table: 'palettes', references: ['id', 'code'] }],
	},
	threads: { columns: ['id', 'pinned'], foreignKeys: [{ columns: ['pinned'], table: 'posts', references: ['id'] }] },
	posts: { columns: ['id', 'thread_id', 'image'], foreignKeys: [{ columns: ['thread_id'], table: 'threads', references: ['id'] }] },
	teams: { columns: ['id', 'version'], foreignKeys: [] },
}

const vocabulary = { app: 'rows', dimensions: { team: {} }, actions: { 'rows.read': 'Read' }, roles: {} } as const

const tables = defineTables(vocabulary, columns)({
	palettes: { scope: { app: 'the palettes' }, actions: { read: 'rows.read' } },
	shades: { scope: { app: 'the shades of a palette' }, actions: { read: 'rows.read' } },
	threads: { scope: { app: 'the threads' }, actions: { read: 'rows.read' } },
	posts: { scope: { app: 'the posts of a thread' }, actions: { read: 'rows.read' }, files: { image: 'images' } },
	teams: { scope: { dimension: 'team' }, actions: { read: 'rows.read' }, version: 'version' },
})

describe('the plan of the application rows an endpoint access case seeds', () => {
	test('each table after the given tables it links to, by the foreign keys the values leave to the link', () => {
		const plan = applicationRowsPlan(tables, { shades: { name: 'Red' }, palettes: {} })
		expect(plan.refusals).toEqual([])
		expect(plan.order).toEqual(['palettes', 'shades'])
		expect(plan.links['shades']?.map((key) => key.table)).toEqual(['palettes'])
		// Given in full, the key is the author's, and nothing links the two.
		const given = applicationRowsPlan(tables, { shades: { palette_id: 'p', palette_code: 'c' }, palettes: {} })
		expect(given.links['shades']).toEqual([])
	})

	test('a table outside the application, a column it lacks, a stamped or file column, part of a key and a cycle are refused', () => {
		expect(applicationRowsPlan(tables, { teams: {}, missing: {}, posts: { id: 'x', image: 'f', titel: 't' } }).refusals).toEqual([
			{ kind: 'table', table: 'missing', mode: null },
			{ kind: 'stamped', table: 'posts', column: 'id' },
			{ kind: 'file', table: 'posts', column: 'image' },
			{ kind: 'column', table: 'posts', column: 'titel' },
			{ kind: 'table', table: 'teams', mode: 'dimension' },
		])
		expect(applicationRowsPlan(tables, { shades: { palette_code: 'c' }, palettes: {} }).refusals).toEqual([
			expect.objectContaining({ kind: 'partial-key', table: 'shades', columns: ['palette_code'] }),
		])
		expect(applicationRowsPlan(tables, { threads: {}, posts: {} }).refusals).toEqual([{ kind: 'cycle', tables: ['posts', 'threads'] }])
		// A value for one of the keys breaks the cycle.
		expect(applicationRowsPlan(tables, { threads: { pinned: null }, posts: {} }).order).toEqual(['threads', 'posts'])
	})

	test('a key is given whole or not at all, whichever table it references', () => {
		const [refusal] = applicationRowsPlan(tables, { shades: { palette_code: 'c' } }).refusals
		expect(refusal).toEqual(expect.objectContaining({ kind: 'partial-key', table: 'shades', columns: ['palette_code'] }))
		expect(refusal === undefined ? '' : applicationRowRefusalText(refusal)).toBe(
			'shades.palette_code is part of the foreign key to palettes (palette_id, palette_code), which is given whole or not at all',
		)
		expect(applicationRowsPlan(tables, { shades: { palette_id: 'p', palette_code: 'c' } }).refusals).toEqual([])
	})

	test('a column takes one value, and the columns of a refused table are not judged', () => {
		expect(applicationRowsPlan(tables, { posts: { thread_id: ['a'] }, teams: { version: { x: 1 } } }).refusals).toEqual([
			{ kind: 'value', table: 'posts', column: 'thread_id', given: 'array' },
			{ kind: 'table', table: 'teams', mode: 'dimension' },
		])
	})
})
