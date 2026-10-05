import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBoard } from '../src/build-status'
import { makeFixture } from './helpers'

test('old boards keep arbitrary timestamp strings, strip extensions and recover atomically on corruption', () => {
	const fixture = makeFixture()
	try {
		mkdirSync(join(fixture.fabrikaDir, 'build'), { recursive: true })
		const path = join(fixture.fabrikaDir, 'build', 'status.json')
		const board = { 'ISSUE-1': { status: 'done', at: 'legacy timestamp', ignored: true }, 'ISSUE-2': { status: 'blocked', at: '', reason: '' } }
		writeFileSync(path, JSON.stringify(board))
		expect(readBoard(fixture.fabrikaDir)).toEqual({
			'ISSUE-1': { status: 'done', at: 'legacy timestamp' },
			'ISSUE-2': { status: 'blocked', at: '', reason: '' },
		})
		writeFileSync(path, JSON.stringify({ ...board, 'ISSUE-3': { status: 'running', at: '' } }))
		expect(readBoard(fixture.fabrikaDir)).toEqual({})
		writeFileSync(path, '{broken')
		expect(readBoard(fixture.fabrikaDir)).toEqual({})
	} finally {
		fixture.cleanup()
	}
})
