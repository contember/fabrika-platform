import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { type Fixture, makeFixture } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../src/bin.ts')

let fx: Fixture | null = null
afterEach(() => fx?.cleanup())

async function run(args: string[], cwd?: string) {
	const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
		cwd: cwd ?? process.cwd(),
		env: { ...process.env, FABRIKA_PORT: '19986', FABRIKA_SESSION_ID: 's_cli_test' },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	const code = await proc.exited
	return { code, stdout, stderr }
}

test('init scaffolds layout and emits an ok JSON summary', async () => {
	fx = makeFixture(false)
	const { code, stdout } = await run(['init', fx.root, '--no-daemon', '--no-open'])
	expect(code).toBe(0)
	const summary = JSON.parse(stdout.trim())
	expect(summary.ok).toBe(true)
	expect(summary.fabrikaDir).toBe(join(fx.root, '.fabrika'))
	expect(existsSync(join(fx.root, '.fabrika', 'config.json'))).toBe(true)
	expect(existsSync(join(fx.root, '.fabrika', 'intent'))).toBe(true)
	expect(summary.agents).toEqual(['claude', 'codex'])
})

test('a project initialized in Codex can resume in Claude without losing phase state', async () => {
	fx = makeFixture(false)
	const codexInit = await run([
		'init',
		fx.root,
		'--agent',
		'codex',
		'--no-daemon',
		'--no-open',
	])
	expect(codexInit.code).toBe(0)
	expect(JSON.parse(codexInit.stdout).agents).toEqual(['codex'])
	expect(existsSync(join(fx.root, '.agents/skills/fabrika/SKILL.md'))).toBe(true)
	expect(existsSync(join(fx.root, '.claude'))).toBe(false)

	fx.write('.fabrika/intent/brief.md', '# Shared brief')
	const beforeHandoff = await run(['next', '--dir', fx.root])
	expect(beforeHandoff.stdout).toContain('## Phase 2/8 - Vision')

	const claudeResume = await run([
		'init',
		fx.root,
		'--agent',
		'claude',
		'--no-daemon',
		'--no-open',
	])
	expect(claudeResume.code).toBe(0)
	expect(JSON.parse(claudeResume.stdout).agents).toEqual(['claude'])
	expect(existsSync(join(fx.root, '.claude/skills/fabrika/SKILL.md'))).toBe(true)

	const afterHandoff = await run(['next', '--dir', fx.root])
	expect(afterHandoff.stdout).toContain('## Phase 2/8 - Vision')
	expect(afterHandoff.stdout).toContain('(intake ✓)')
})

test('next emits the phase-1 packet on a fresh init', async () => {
	fx = makeFixture() // already inited
	const { code, stdout } = await run(['next', '--dir', fx.root])
	expect(code).toBe(0)
	expect(stdout).toContain('## Phase 1/8 - Intake')
	expect(stdout).toContain('Gate:')
})

test('advance is reflected in subsequent next (derivation moves forward)', async () => {
	fx = makeFixture()

	let nxt = await run(['next', '--dir', fx.root])
	expect(nxt.stdout).toContain('## Phase 1/8 - Intake')

	const blocked = await run(['advance', '--dir', fx.root, '--force'])
	expect(blocked.code).toBe(1)
	expect(blocked.stderr).toContain('missing produce: .fabrika/intent/brief.md')

	fx.write('.fabrika/intent/brief.md', '# brief')
	nxt = await run(['next', '--dir', fx.root])
	expect(nxt.stdout).toContain('## Phase 2/8 - Vision')
	expect(nxt.stdout).toContain('(intake ✓)')

	const visionBlocked = await run(['advance', '--dir', fx.root, '--force'])
	expect(visionBlocked.code).toBe(1)
	expect(visionBlocked.stderr).toContain('.fabrika/principles/principles.md')

	fx.write('.fabrika/intent/glossary.md', '# glossary')
	fx.write('.fabrika/principles/principles.md', '# principles')
	nxt = await run(['next', '--dir', fx.root])
	expect(nxt.stdout).toContain('## Phase 3/8 - User flows')
	expect(nxt.stdout).toContain('vision ✓')
})

test('advance blocks with a checklist when produces are missing', async () => {
	fx = makeFixture() // empty -> phase intake, brief.md missing
	const { code, stderr } = await run(['advance', '--dir', fx.root, '--force'])
	expect(code).toBe(1)
	expect(stderr).toContain('missing produce: .fabrika/intent/brief.md')
})

test('next without init fails clearly', async () => {
	fx = makeFixture(false) // not inited
	const { code, stderr } = await run(['next', '--dir', fx.root])
	expect(code).toBe(1)
	expect(stderr).toContain('fabrika builder init')
})

test('build driver: readiness follows DONE deps; done unblocks dependents', async () => {
	fx = makeFixture()
	fx.write(
		'.fabrika/issues/ISSUE-001.md',
		'---\ngoal: scaffold app\nsatisfies: [smoke]\ndepends_on: []\ntouches: [app]\n---\nbody\n',
	)
	fx.write(
		'.fabrika/issues/ISSUE-002.md',
		'---\ngoal: cart page\nsatisfies: [cart-add]\ndepends_on: [ISSUE-001]\ntouches: [routes/cart]\n---\nbody\n',
	)

	const first = await run(['build', '--dir', fx.root])
	expect(first.code).toBe(0)
	expect(first.stdout).toContain('1 ready')
	expect(first.stdout).toContain('1 waiting')
	expect(first.stdout).toContain('agents/build-orchestrator.md')
	expect(first.stdout).toContain('Do not spawn a nested orchestrator')
	expect(first.stdout).toContain('ISSUE-001')
	expect(first.stdout).toContain('scaffold app')
	expect(first.stdout).not.toContain('## Build issue') // no per-issue drip by default

	const detail = await run(['build', '--issue', 'ISSUE-001', '--dir', fx.root])
	expect(detail.stdout).toContain('## Build issue ISSUE-001')
	expect(detail.stdout).toContain('scaffold app')

	const next = await run(['build', 'done', 'ISSUE-001', '--dir', fx.root])
	expect(next.code).toBe(0)
	expect(next.stdout).toContain('ISSUE-001 marked done')
	expect(next.stdout).toContain('1/2 done')
	expect(next.stdout).toContain('ISSUE-002')

	const status = await run(['build', 'status', '--dir', fx.root])
	expect(status.stdout).toContain('1/2 done')
})
