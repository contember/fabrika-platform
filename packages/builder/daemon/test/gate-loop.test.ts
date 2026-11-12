import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readApprovals, writeApprovals } from '../../shared/approvals'
import { builderDaemonUrl } from '../../shared/urls'
import { type RunningDaemon, startDaemon } from '../src/index'
import { scratchDir } from './scratch'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(HERE, '../../cli/src/bin.ts')

let daemon: RunningDaemon
let base: string
let wsBase: string
let dataDir: string
let sessionsDir: string

beforeAll(() => {
	dataDir = scratchDir('fabrika-gate-loop-')
	sessionsDir = join(dataDir, 'sessions')
	daemon = startDaemon({ port: 0, sessionsDir })
	base = builderDaemonUrl(daemon.port)
	wsBase = builderDaemonUrl(daemon.port, 'ws')
})

afterAll(() => {
	daemon.stop()
	rmSync(dataDir, { recursive: true, force: true })
})

async function openGate(sessionId: string, gate: string): Promise<void> {
	const canvasDir = scratchDir('fabrika-gate-canvas-')
	writeFileSync(join(canvasDir, 'view.jsx'), "<Section title='Review me'>body</Section>")
	const res = await fetch(`${base}/api/session/${sessionId}/plan`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ directory: canvasDir, projectRoot: canvasDir, gate }),
	})
	const body = await res.json()
	rmSync(canvasDir, { recursive: true, force: true })
	if (!body.ok) throw new Error(`gate open failed: ${JSON.stringify(body)}`)
}

async function runCli(
	args: string[],
	env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['bun', 'run', CLI_BIN, ...args], {
		env: {
			...process.env,
			FABRIKA_PORT: String(daemon.port),
			FABRIKA_DATA_DIR: dataDir,
			...env,
		},
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

function openSocket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.addEventListener('open', () => resolve(ws), { once: true })
		ws.addEventListener('error', (e) => reject(e), { once: true })
	})
}

describe('gate interactive loop', () => {
	test('WS submit on an open gate resolves a pending gate-wait with the feedback', async () => {
		const sessionId = 'gate-loop-submit'
		await openGate(sessionId, 'vision')

		const waiter = await openSocket(`${wsBase}/ws/wait/${sessionId}`)

		const feedbackMarkdown = '## General\nLooks good, tighten the hero copy.\n\n- [block-2] needs a CTA'

		const relayed = new Promise<{ feedback: string; closed: boolean }>((resolve, reject) => {
			let payload: unknown = null
			waiter.addEventListener('message', (ev) => {
				payload = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
			})
			waiter.addEventListener('close', () => {
				if (isRecord(payload) && payload['type'] === 'submit' && typeof payload['feedback'] === 'string') {
					resolve({ feedback: payload['feedback'], closed: true })
				} else reject(new Error('waiter closed without a submit frame'))
			})
			setTimeout(() => reject(new Error('timed out waiting for relay')), 4000)
		})

		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: feedbackMarkdown }))

		const result = await relayed
		expect(result.closed).toBe(true)
		expect(result.feedback).toBe(feedbackMarkdown)

		const stored = await (
			await fetch(`${base}/api/session/${sessionId}/revision/1/feedback`)
		).json()
		expect(stored.feedback).toBe(feedbackMarkdown)

		const consume = await (
			await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })
		).json()
		expect(consume.found).toBe(true)
		expect(consume.feedback).toBe(feedbackMarkdown)

		const consumeAgain = await (
			await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })
		).json()
		expect(consumeAgain.found).toBe(false)

		browser.close()
	})

	test('BUG B happy-path: gate wait PEEKs (no consume), then advance consumes and the phase derives forward', async () => {
		const sessionId = 'gate-loop-e2e'

		const repo = scratchDir('fabrika-e2e-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		writeFileSync(
			join(repo, '.fabrika', 'config.json'),
			JSON.stringify({ profile: 'cf-lightweight', sessionId, createdAt: new Date().toISOString() }),
		)
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')
		const fabrikaDir = join(repo, '.fabrika')
		const cliEnv = { FABRIKA_SESSION_ID: sessionId }

		await openGate(sessionId, 'intake')
		const feedbackMarkdown = 'Intake looks right. Proceed.'
		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: feedbackMarkdown }))
		await new Promise((r) => setTimeout(r, 100))
		browser.close()

		const beforePhase = await (
			await fetch(
				`${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}&session=${encodeURIComponent(sessionId)}`,
			)
		).json()
		expect(beforePhase.current).toBe('intake')

		const waitR = await runCli(['gate', 'wait', '--root', repo], cliEnv)
		expect(waitR.code).toBe(0)
		expect(waitR.stdout).toBe(feedbackMarkdown)

		const stillPending = await (
			await fetch(`${base}/api/session/${sessionId}/revision/1/feedback`)
		).json()
		expect(stillPending.feedback).toBe(feedbackMarkdown)

		const advR = await runCli(['advance', '--dir', repo], cliEnv)
		expect(advR.code).toBe(0)
		expect(advR.stdout).toContain('OK: phase 1/7 (intake) satisfied.')
		expect(advR.stdout).toContain('Next -> phase 2/7')
		expect(advR.stderr).toContain('submitted without a verdict')

		const afterPhase = await (
			await fetch(
				`${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}&session=${encodeURIComponent(sessionId)}`,
			)
		).json()
		expect(afterPhase.completed).toContain('intake')
		expect(afterPhase.current).toBe('vision')

		rmSync(repo, { recursive: true, force: true })
	})

	test('re-opening a gate un-satisfies its phase: only the LATEST gate revision counts', async () => {
		const sessionId = 'gate-loop-reopen'

		const repo = scratchDir('fabrika-reopen-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')
		const fabrikaDir = join(repo, '.fabrika')
		const phaseUrl = `${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}&session=${encodeURIComponent(sessionId)}`

		await openGate(sessionId, 'intake')
		const browser1 = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser1.send(JSON.stringify({ type: 'submit', feedback: 'Intake good, proceed.' }))
		await new Promise((r) => setTimeout(r, 100))
		browser1.close()
		const consume = await (
			await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })
		).json()
		expect(consume.found).toBe(true)

		const afterConsume = await (await fetch(phaseUrl)).json()
		expect(afterConsume.completed).toContain('intake')
		expect(afterConsume.current).toBe('vision')

		await openGate(sessionId, 'intake')

		const afterReopen = await (await fetch(phaseUrl)).json()
		expect(afterReopen.current).toBe('intake')
		expect(afterReopen.completed).not.toContain('intake')

		rmSync(repo, { recursive: true, force: true })
	})

	test('advance over a "Request changes" verdict warns, advances, and the phase state keeps the verdict', async () => {
		const sessionId = 'gate-loop-verdict'
		const repo = scratchDir('fabrika-verdict-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		writeFileSync(join(repo, '.fabrika', 'config.json'), JSON.stringify({ profile: 'zerops-app', sessionId, createdAt: new Date().toISOString() }))
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')
		const fabrikaDir = join(repo, '.fabrika')
		const phaseUrl = `${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}&session=${encodeURIComponent(sessionId)}`
		const cliEnv = { FABRIKA_SESSION_ID: sessionId }

		await openGate(sessionId, 'intake')
		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: 'Scope is wrong.', responses: [{ id: 'verdict', value: 'Request changes' }] }))
		await new Promise((r) => setTimeout(r, 100))
		browser.close()

		const advR = await runCli(['advance', '--dir', repo], cliEnv)
		expect(advR.code).toBe(0)
		expect(advR.stderr).toContain('warning: gate "intake" was answered "Request changes"')

		const after = await (await fetch(phaseUrl)).json()
		expect(after.current).toBe('vision')
		expect(after.verdicts).toEqual({ intake: 'changes' })

		const next = await runCli(['next', '--dir', repo], cliEnv)
		expect(next.stdout).toContain('Review:  advanced over requested changes: intake')

		rmSync(repo, { recursive: true, force: true })
	})

	test('a refused advance still prints the verdict warning for the feedback it consumed', async () => {
		const sessionId = 'gate-loop-refused'
		const repo = scratchDir('fabrika-refused-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		writeFileSync(join(repo, '.fabrika', 'config.json'), JSON.stringify({ profile: 'zerops-app', sessionId, createdAt: new Date().toISOString() }))

		await openGate(sessionId, 'intake')
		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: 'Wrong scope.', responses: [{ id: 'verdict', value: 'Request changes' }] }))
		await new Promise((r) => setTimeout(r, 100))
		browser.close()

		const advR = await runCli(['advance', '--dir', repo], { FABRIKA_SESSION_ID: sessionId })
		expect(advR.code).toBe(1)
		expect(advR.stderr).toContain('missing produce: .fabrika/intent/brief.md')
		expect(advR.stderr).toContain('warning: gate "intake" was answered "Request changes"')

		rmSync(repo, { recursive: true, force: true })
	})

	test('an approved gate advances without a warning', async () => {
		const sessionId = 'gate-loop-approve'
		const repo = scratchDir('fabrika-approve-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		writeFileSync(join(repo, '.fabrika', 'config.json'), JSON.stringify({ profile: 'zerops-app', sessionId, createdAt: new Date().toISOString() }))
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')

		await openGate(sessionId, 'intake')
		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: 'Good.', responses: [{ id: 'verdict', value: 'Approve' }] }))
		await new Promise((r) => setTimeout(r, 100))
		browser.close()

		const advR = await runCli(['advance', '--dir', repo], { FABRIKA_SESSION_ID: sessionId })
		expect(advR.code).toBe(0)
		expect(advR.stderr).not.toContain('warning')

		rmSync(repo, { recursive: true, force: true })
	})

	test('pending feedback on a later gate leaves an earlier reviewed gate complete', async () => {
		const sessionId = 'gate-loop-earlier'
		const repo = scratchDir('fabrika-earlier-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		mkdirSync(join(repo, '.fabrika', 'principles'), { recursive: true })
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')
		const fabrikaDir = join(repo, '.fabrika')
		const phaseUrl = `${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}&session=${encodeURIComponent(sessionId)}`

		await openGate(sessionId, 'intake')
		const first = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		first.send(JSON.stringify({ type: 'submit', feedback: 'Intake good.' }))
		await new Promise((r) => setTimeout(r, 100))
		first.close()
		await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })

		writeFileSync(join(repo, '.fabrika', 'intent', 'glossary.md'), '# glossary')
		writeFileSync(join(repo, '.fabrika', 'principles', 'principles.md'), '# principles')
		await openGate(sessionId, 'vision')
		const second = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		second.send(JSON.stringify({ type: 'submit', feedback: 'Vision pending.' }))
		await new Promise((r) => setTimeout(r, 100))
		second.close()

		const state = await (await fetch(phaseUrl)).json()
		expect(state.completed).toEqual(['intake'])
		expect(state.current).toBe('vision')
		expect(state.satisfied).toBe(true)

		rmSync(repo, { recursive: true, force: true })
	})

	test('build done on the design checkpoint refuses before a review, then records the design gate verdict', async () => {
		const sessionId = 'gate-loop-design-checkpoint'
		const repo = scratchDir('fabrika-design-repo-')
		const fabrikaDir = join(repo, '.fabrika')
		mkdirSync(join(fabrikaDir, 'issues'), { recursive: true })
		writeFileSync(
			join(fabrikaDir, 'config.json'),
			JSON.stringify({ profile: 'zerops-app', sessionId, createdAt: new Date().toISOString() }),
		)
		writeFileSync(
			join(fabrikaDir, 'issues', 'ISSUE-004.md'),
			'---\ngoal: Design checkpoint\nsatisfies: []\ndepends_on: []\ntouches: []\nverify: []\ngate: design-checkpoint\n---\nbody\n',
		)
		const cliEnv = { FABRIKA_SESSION_ID: sessionId }

		const unopened = await runCli(['build', 'done', 'ISSUE-004', '--dir', repo], cliEnv)
		expect(unopened.code).toBe(1)
		expect(unopened.stderr).toContain('the "design-checkpoint" gate has no submitted review')

		// A review from the removed design phase, approved and consumed, never stands in for the checkpoint's.
		await openGate(sessionId, 'design')
		const old = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		old.send(JSON.stringify({ type: 'submit', feedback: 'Mockup ok.', responses: [{ id: 'verdict', value: 'Approve' }] }))
		await new Promise((r) => setTimeout(r, 100))
		old.close()
		await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })
		const stale = await runCli(['build', 'done', 'ISSUE-004', '--dir', repo], cliEnv)
		expect(stale.code).toBe(1)

		await openGate(sessionId, 'design-checkpoint')
		const unreviewed = await runCli(['build', 'done', 'ISSUE-004', '--dir', repo], cliEnv)
		expect(unreviewed.code).toBe(1)

		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: 'Price is hard to read.', responses: [{ id: 'verdict', value: 'Request changes' }] }))
		await new Promise((r) => setTimeout(r, 100))
		browser.close()

		const refused = await runCli(['build', 'done', 'ISSUE-004', '--verify', 'true', '--dir', repo], cliEnv)
		expect(refused.code).toBe(1)
		expect(refused.stderr).toContain('takes no --verify')

		const done = await runCli(['build', 'done', 'ISSUE-004', '--dir', repo], cliEnv)
		expect(done.code).toBe(0)
		expect(done.stderr).toContain('answered "Request changes"; recording ISSUE-004 anyway')
		const board = JSON.parse(readFileSync(join(fabrikaDir, 'build', 'status.json'), 'utf-8'))
		expect(board['ISSUE-004'].status).toBe('done')
		expect(board['ISSUE-004'].evidence).toMatchObject({ command: 'design-checkpoint gate review, revision 2', verdict: 'changes' })

		// The review stays readable after it was consumed; a gate never opened has none.
		const again = await (await fetch(`${base}/api/session/${sessionId}/gate/design-checkpoint/consume`, { method: 'POST' })).json()
		expect(again).toEqual({ found: true, revision: 2, verdict: 'changes' })
		const missing = await (await fetch(`${base}/api/session/${sessionId}/gate/tech/consume`, { method: 'POST' })).json()
		expect(missing).toEqual({ found: false })
	test('re-opening a gate over pending feedback does not complete the phase of a project that keeps approvals', async () => {
		const sessionId = 'gate-loop-reopen'
		const repo = scratchDir('fabrika-reopen-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		writeApprovals(repo, {})
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')
		const phaseUrl = `${base}/api/phase?root=${encodeURIComponent(join(repo, '.fabrika'))}&session=${encodeURIComponent(sessionId)}`

		await openGate(sessionId, 'intake')
		const ws = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		ws.send(JSON.stringify({ type: 'submit', feedback: 'Tighten the non-goals.' }))
		await new Promise((r) => setTimeout(r, 100))
		ws.close()
		await expect(openGate(sessionId, 'intake')).rejects.toThrow('Unconsumed feedback')

		const state = await (await fetch(phaseUrl)).json()
		expect(state.current).toBe('intake')
		expect(state.completed).toEqual([])

		rmSync(repo, { recursive: true, force: true })
	})

	test('the first advance of a project without approvals records the gated phases it completed, and an edit re-opens them', async () => {
		const sessionId = 'gate-loop-backfill'
		const repo = scratchDir('fabrika-backfill-repo-')
		mkdirSync(join(repo, '.fabrika', 'intent'), { recursive: true })
		mkdirSync(join(repo, '.fabrika', 'principles'), { recursive: true })
		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a thing')
		writeFileSync(join(repo, '.fabrika', 'intent', 'glossary.md'), '# glossary')
		writeFileSync(join(repo, '.fabrika', 'principles', 'principles.md'), '# principles')
		writeFileSync(join(repo, '.fabrika', 'config.json'), JSON.stringify({ profile: 'zerops-app', sessionId, createdAt: new Date().toISOString() }))
		const phaseUrl = `${base}/api/phase?root=${encodeURIComponent(join(repo, '.fabrika'))}&session=${encodeURIComponent(sessionId)}`
		const submit = async (gate: string) => {
			await openGate(sessionId, gate)
			const ws = await openSocket(`${wsBase}/ws/session/${sessionId}`)
			ws.send(JSON.stringify({ type: 'submit', feedback: 'Fine.', responses: [{ id: 'verdict', value: 'Approve' }] }))
			await new Promise((r) => setTimeout(r, 100))
			ws.close()
		}

		await submit('intake')
		await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })
		await submit('vision')
		expect(readApprovals(repo)).toBeNull()

		const adv = await runCli(['advance', '--dir', repo], { FABRIKA_SESSION_ID: sessionId })
		expect(adv.code).toBe(0)
		const approvals = readApprovals(repo)
		expect(Object.keys(approvals ?? {}).sort()).toEqual(['intake', 'vision'])
		expect(approvals?.vision?.waived).toBeUndefined()
		expect(approvals?.vision?.inputs['.fabrika/intent/glossary.md']).toMatch(/^[0-9a-f]{64}$/)

		writeFileSync(join(repo, '.fabrika', 'intent', 'brief.md'), '# brief\nbuild a different thing')
		const state = await (await fetch(phaseUrl)).json()
		expect(state.current).toBe('intake')
		expect(state.stale).toEqual(['.fabrika/intent/brief.md'])

		// A waived gate is recorded as waived.
		const forced = await runCli(['advance', '--force', '--dir', repo], { FABRIKA_SESSION_ID: sessionId })
		expect(forced.code).toBe(0)
		expect(readApprovals(repo)?.intake?.waived).toBe(true)

		rmSync(repo, { recursive: true, force: true })
	})

	test('fast-path: POST feedback/consume returns pending feedback when no waiter was connected', async () => {
		const sessionId = 'gate-loop-fastpath'
		await openGate(sessionId, 'design')

		const feedbackMarkdown = 'Use the brand palette, not the placeholder grays.'

		const browser = await openSocket(`${wsBase}/ws/session/${sessionId}`)
		browser.send(JSON.stringify({ type: 'submit', feedback: feedbackMarkdown }))
		await new Promise((r) => setTimeout(r, 100))
		browser.close()

		const consume = await (
			await fetch(`${base}/api/session/${sessionId}/feedback/consume`, { method: 'POST' })
		).json()
		expect(consume.found).toBe(true)
		expect(consume.revision).toBe(1)
		expect(consume.feedback).toBe(feedbackMarkdown)
	})
})
