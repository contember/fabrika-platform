import { afterAll, afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { derivePhase, offlineGateProbe } from '../src/derive'
import { type Fixture, makeFixture } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../src/bin.ts')

// Every CLI child gets its own home, temp dir and data root: a daemon it spawns must never touch the developer's ~/.fabrika.
const ISOLATED_ROOT = mkdtempSync(join(tmpdir(), 'fabrika-daemon-integration-'))
const ISOLATED_HOME = join(ISOLATED_ROOT, 'home')
const ISOLATED_TEMP = join(ISOLATED_ROOT, 'temp')
const ISOLATED_DATA_DIR = join(ISOLATED_ROOT, 'data')
const ISOLATED_SESSIONS_DIR = join(ISOLATED_DATA_DIR, 'sessions')
const SPAWNED_DAEMON_PID_FILE = join(ISOLATED_TEMP, 'fabrika', 'daemon.pid')
mkdirSync(ISOLATED_HOME, { recursive: true })
mkdirSync(ISOLATED_TEMP, { recursive: true })

let fx: Fixture | null = null
let server: ReturnType<typeof Bun.serve> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portOf(listening: { port?: number }): number {
	if (listening.port === undefined) throw new Error('Bun.serve did not report a port')
	return listening.port
}

function unusedPort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = portOf(probe)
	probe.stop(true)
	return port
}

afterEach(() => {
	fx?.cleanup()
	server?.stop(true)
	server = null
})

afterAll(() => {
	// Only a CLI child of this file can have written this pid file, so the pid is one this file started.
	if (existsSync(SPAWNED_DAEMON_PID_FILE)) {
		const pid = Number(readFileSync(SPAWNED_DAEMON_PID_FILE, 'utf-8').trim())
		try {
			process.kill(pid, 'SIGTERM')
		} catch {}
	}
	rmSync(ISOLATED_ROOT, { recursive: true, force: true })
})

function startMockDaemon(opts: {
	phaseState: object
	feedback?: string | null
	sessionsDir?: string
	healthPid?: number
	onPhaseQuery?: (params: URLSearchParams) => void
	onPlan?: (body: Record<string, unknown>) => void
}): number {
	let feedback = opts.feedback ?? null
	const sessionsDir = opts.sessionsDir ?? ISOLATED_SESSIONS_DIR
	const mock = Bun.serve({
		port: 0,
		async fetch(req, srv) {
			const url = new URL(req.url)
			if (url.pathname === '/health') {
				return Response.json({
					ok: true,
					version: 'test',
					pid: opts.healthPid ?? process.pid,
					dataDir: dirname(sessionsDir),
					sessionsDir,
					sessions: 1,
				})
			}
			if (url.pathname.endsWith('/plan') && req.method === 'POST') {
				const body: unknown = await req.json()
				if (!isRecord(body)) return Response.json({ error: 'invalid body' }, { status: 400 })
				opts.onPlan?.(body)
				return Response.json({ ok: true, isNew: false, revision: 1, sessionId: 's_int', gate: body['gate'], canvasFiles: [] })
			}
			if (url.pathname === '/api/phase') {
				opts.onPhaseQuery?.(url.searchParams)
				return Response.json(opts.phaseState)
			}
			if (url.pathname.endsWith('/feedback/consume') && req.method === 'POST') {
				if (feedback !== null) {
					const out = feedback
					feedback = null // consumed
					return Response.json({ found: true, feedback: out })
				}
				return Response.json({ found: false })
			}
			return new Response('not found', { status: 404 })
		},
	})
	server = mock
	return portOf(mock)
}

async function run(args: string[], port: number) {
	const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
		env: {
			...process.env,
			HOME: ISOLATED_HOME,
			TMPDIR: ISOLATED_TEMP,
			FABRIKA_DATA_DIR: ISOLATED_DATA_DIR,
			FABRIKA_PORT: String(port),
			FABRIKA_SESSION_ID: 's_int',
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

test('ensure-daemon rejects an unmanaged daemon with a different data root', async () => {
	const port = startMockDaemon({
		phaseState: {},
		sessionsDir: join(ISOLATED_ROOT, 'other-root', 'sessions'),
		healthPid: 999_999_999,
	})

	const result = await run(['ensure-daemon'], port)
	expect(result.code).toBe(1)
	expect(result.stderr).toContain('data-root mismatch')
	expect(result.stderr).toContain('Not starting a second daemon')
	expect(result.stdout).toContain('"running":false')
	// A daemon spawned here would bind the port as soon as the unmanaged one stops.
	expect(existsSync(SPAWNED_DAEMON_PID_FILE)).toBe(false)
})

test('advance succeeds online when gate feedback is consumable', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	const phaseState = {
		...derivePhase(fx.root, offlineGateProbe),
		current: 'intake',
		index: 0,
		completed: [],
		gate: true,
		satisfied: true,
	}
	const port = startMockDaemon({ phaseState, feedback: 'looks good, ship it' })

	const r = await run(['advance', '--dir', fx.root], port)
	expect(r.code).toBe(0)
	expect(r.stdout).toContain('OK: phase 1/8 (intake) satisfied.')
	expect(r.stdout).toContain('Next -> phase 2/8')
})

test('advance online blocks when no feedback is pending', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	const phaseState = {
		current: 'intake',
		index: 0,
		completed: [],
		reads: [],
		produces: ['.fabrika/intent/brief.md'],
		gate: true,
		satisfied: true,
	}
	const port = startMockDaemon({ phaseState, feedback: null })

	const r = await run(['advance', '--dir', fx.root], port)
	expect(r.code).toBe(1)
	expect(r.stderr).toContain('no submitted feedback to consume')
})

test('BUG A: next sends the sessionId to /api/phase so the daemon can evaluate the gate', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	let captured: URLSearchParams | null = null
	const phaseState = {
		current: 'vision',
		index: 1,
		completed: ['intake'],
		reads: [],
		produces: ['.fabrika/intent/glossary.md'],
		gate: true,
		satisfied: false,
	}
	const port = startMockDaemon({
		phaseState,
		onPhaseQuery: (params) => {
			captured = params
		},
	})

	const r = await run(['next', '--dir', fx.root], port)
	expect(r.code).toBe(0)
	expect(captured).not.toBeNull()
	expect(captured!.get('session')).toBe('s_int')
	expect(captured!.get('root')).toContain('.fabrika')
})

test('BUG A: advance sends the sessionId to /api/phase', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	let captured: URLSearchParams | null = null
	const phaseState = {
		...derivePhase(fx.root, offlineGateProbe),
		current: 'intake',
		index: 0,
		completed: [],
		gate: true,
		satisfied: true,
	}
	const port = startMockDaemon({
		phaseState,
		feedback: 'ship it',
		onPhaseQuery: (params) => {
			captured = params
		},
	})

	const r = await run(['advance', '--dir', fx.root], port)
	expect(r.code).toBe(0)
	expect(captured).not.toBeNull()
	expect(captured!.get('session')).toBe('s_int')
})

test("next uses the daemon's canonical phase state when reachable", async () => {
	fx = makeFixture()
	const phaseState = {
		current: 'flows',
		index: 2,
		completed: ['intake', 'vision'],
		reads: ['.fabrika/intent/brief.md'],
		produces: ['.fabrika/architecture/flows/*.flow.md'],
		gate: true,
		satisfied: false,
	}
	const port = startMockDaemon({ phaseState })

	const r = await run(['next', '--dir', fx.root], port)
	expect(r.stdout).toContain('## Phase 3/8 - User flows')
	expect(r.stdout).toContain('intake ✓')
	expect(r.stdout).toContain('vision ✓')
})

test('gate open --view sends the exact named view, not a containing directory', async () => {
	const gatesDir = mkdtempSync(join(tmpdir(), 'fabrika-gates-'))
	writeFileSync(join(gatesDir, 'brief.jsx'), "<Section title='B'>x</Section>")
	writeFileSync(join(gatesDir, 'vision.jsx'), "<Section title='V'>y</Section>")

	const capture: { pushed: Record<string, unknown> | null } = { pushed: null }
	const phaseState = { current: 'vision', index: 1, completed: ['intake'], reads: [], produces: [], gate: true, satisfied: false }
	const port = startMockDaemon({
		phaseState,
		onPlan: (body) => {
			capture.pushed = body
		},
	})

	const r = await run(['gate', 'open', 'vision', '--view', join(gatesDir, 'vision.jsx'), '--root', gatesDir], port)
	expect(r.code).toBe(0)
	expect(capture.pushed).not.toBeNull()
	expect(capture.pushed?.['view']).toBe(join(gatesDir, 'vision.jsx'))
	expect(capture.pushed?.['directory']).toBeUndefined()

	rmSync(gatesDir, { recursive: true, force: true })
})

test('gate open requires an unambiguous source selection', async () => {
	const gatesDir = mkdtempSync(join(tmpdir(), 'fabrika-gates-source-'))
	const view = join(gatesDir, 'vision.jsx')
	writeFileSync(view, "<Section title='V'>y</Section>")

	const both = await run([
		'gate',
		'open',
		'vision',
		'--view',
		view,
		'--dir',
		gatesDir,
		'--root',
		gatesDir,
	], unusedPort())
	expect(both.code).toBe(1)
	expect(both.stderr).toContain('either --view or --dir, not both')

	const directoryAsView = await run([
		'gate',
		'open',
		'vision',
		'--view',
		gatesDir,
		'--root',
		gatesDir,
	], unusedPort())
	expect(directoryAsView.code).toBe(1)
	expect(directoryAsView.stderr).toContain('--view must be a file')

	rmSync(gatesDir, { recursive: true, force: true })
})
