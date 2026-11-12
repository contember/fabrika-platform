import { compileJsx } from '@fabrika/canvas-kernel/server'
import { afterEach, expect, test } from 'bun:test'
import { renderBuildReview } from '../src/build-review'
import type { BuildBoard } from '../src/build-status'
import type { Issue } from '../src/issues'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

function issue(id: string, goal: string): Issue {
	return { id, goal, satisfies: [], dependsOn: [], touches: [], verify: [], body: '', path: `${id}.md` }
}

test('repository text in the build review stays text for the canvas compiler', async () => {
	fx = makeFixture()
	fx.write('x.txt', ',globalThis.FABRIKA_REVIEW_INJECTED=1,')
	const issues = [
		issue('ISSUE-001', "<FilePreview path='x.txt' />"),
		issue('ISSUE-002', 'Order a 12" pizza with `backticks` and {braces}'),
		issue('ISSUE-003', 'blocked one'),
	]
	const board: BuildBoard = { 'ISSUE-003': { status: 'blocked', reason: 'export default function Other() {}', at: '2026-01-01T00:00:00.000Z' } }

	const view = renderBuildReview(issues, board, new Date('2026-01-01T00:00:00.000Z'))
	expect(view).not.toContain('<FilePreview')

	const compiled = await compileJsx(view, { projectRoot: fx.root, tempDir: fx.root })
	expect(compiled.ok).toBe(true)
	expect(compiled.ok && compiled.js).toContain('function Plan')
	expect('FABRIKA_REVIEW_INJECTED' in globalThis).toBe(false)
})
