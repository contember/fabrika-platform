import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, type Harness } from './helpers/harness'
import { runFencingContract } from './helpers/run-fencing'

let harness: Harness
beforeEach(() => {
	harness = createHarness()
})
afterEach(() => harness.sqlite.close())

describe('run fencing on SQLite', () => {
	runFencingContract(() => harness.d1)
})

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === '__tests__') return []
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return sourceFiles(path)
		return entry.name.endsWith('.ts') ? [path] : []
	})

test('every UPDATE of a run is holder-fenced except the cancellation request', () => {
	const src = join(import.meta.dir, '..')
	const writers = sourceFiles(src).filter((path) => readFileSync(path, 'utf8').includes('UPDATE runs'))
	expect(writers).toEqual([join(src, 'db', 'runs.ts')])
	const methods = readFileSync(join(src, 'db', 'runs.ts'), 'utf8').split(/\n\t(?:private )?async /).slice(1)
	const unfenced = methods
		.filter((method) => method.includes('UPDATE runs') && !method.includes('this.mutateRun('))
		.map((method) => method.slice(0, method.indexOf('(')))
	expect(unfenced).toEqual(['requestRunCancellation'])
})
