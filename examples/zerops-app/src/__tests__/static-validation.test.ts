import { describe, expect, test } from 'bun:test'
import { parseNotesRows } from '../notes'
import { parseOperationsConfig } from '../operations-config'

describe('note database rows', () => {
	test('filters malformed rows independently and projects only note fields', () => {
		expect(parseNotesRows([
			{ id: '1', workspace: 'acme', title: '  First  ', extra: true },
			null,
			{ id: 2, workspace: 'acme', title: 'bad' },
			{ id: '3', workspace: '', title: '' },
			[],
		])).toEqual([
			{ id: '1', workspace: 'acme', title: '  First  ' },
			{ id: '3', workspace: '', title: '' },
		])
	})
	test.each([null, {}, 'rows', 1])('treats a non-array result as empty: %j', (rows) => {
		expect(parseNotesRows(rows)).toEqual([])
	})
})

describe('Operations browser configuration', () => {
	test('accepts string values without trimming and ignores extensions', () => {
		expect(parseOperationsConfig({ dsn: '', release: ' release ', extra: true })).toEqual({ dsn: '', release: ' release ' })
	})
	test.each([null, [], {}, { dsn: 'dsn' }, { dsn: 1, release: 'release' }, { dsn: 'dsn', release: null }].map(value => ({ value })))(
		'rejects malformed config with the stable diagnostic: %j',
		({ value }) => {
			expect(() => parseOperationsConfig(value)).toThrow('Operations SDK configuration is invalid')
		},
	)
})
