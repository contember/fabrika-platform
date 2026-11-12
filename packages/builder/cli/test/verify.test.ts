import { afterEach, expect, test } from 'bun:test'
import { readBoard } from '../src/build-status'
import { gitState } from '../src/verify'
import { type Fixture, makeFixture } from './helpers'

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

function git(cwd: string, ...args: string[]) {
	const proc = Bun.spawnSync(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
}

test('gitState names the commit and counts only uncommitted application changes', () => {
	fx = makeFixture()
	expect(gitState(fx.root)).toEqual({ commit: null, dirty: false })

	git(fx.root, 'init', '--quiet')
	git(fx.root, 'config', 'status.showUntrackedFiles', 'no')
	fx.write('src/app.ts', 'export {}\n')
	expect(gitState(fx.root)).toEqual({ commit: null, dirty: true })

	git(fx.root, 'add', '--all')
	git(fx.root, 'commit', '--quiet', '-m', 'init')
	const clean = gitState(fx.root)
	expect(clean.commit).toMatch(/^[0-9a-f]{40}$/)
	expect(clean.dirty).toBe(false)

	fx.write('.fabrika/build/status.json', '{}')
	expect(gitState(fx.root).dirty).toBe(false)

	fx.write('src/new.ts', 'export {}\n')
	expect(gitState(fx.root).dirty).toBe(true)
})

test('a build record written before evidence existed still reads', () => {
	fx = makeFixture()
	fx.write('.fabrika/build/status.json', JSON.stringify({ 'ISSUE-001': { status: 'done', at: '2026-01-01T00:00:00.000Z' } }))
	expect(readBoard(fx.fabrikaDir)).toEqual({ 'ISSUE-001': { status: 'done', at: '2026-01-01T00:00:00.000Z' } })
})
