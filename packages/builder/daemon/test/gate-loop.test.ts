import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
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
		expect(advR.stdout).toContain('OK: phase 1/8 (intake) satisfied.')
		expect(advR.stdout).toContain('Next -> phase 2/8')

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
