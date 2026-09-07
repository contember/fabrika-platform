import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { SESSIONS_DIR } from '../src/config'
import { derivePhase, offlineGateProbe } from '../src/derive'
import { type Fixture, makeFixture } from './helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../src/bin.ts')

let fx: Fixture | null = null
let server: ReturnType<typeof Bun.serve> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

afterEach(() => {
	fx?.cleanup()
	server?.stop(true)
	server = null
})

function startMockDaemon(opts: {
	port: number
	phaseState: object
	feedback?: string | null
	sessionsDir?: string
	healthPid?: number
	onPhaseQuery?: (params: URLSearchParams) => void
	onPlan?: (body: Record<string, unknown>) => void
}) {
	let feedback = opts.feedback ?? null
	return Bun.serve({
		port: opts.port,
		async fetch(req, srv) {
			const url = new URL(req.url)
			if (url.pathname === '/health') {
				return Response.json({
					ok: true,
					version: 'test',
					pid: opts.healthPid ?? process.pid,
					dataDir: dirname(opts.sessionsDir ?? SESSIONS_DIR),
					sessionsDir: opts.sessionsDir ?? SESSIONS_DIR,
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
}

async function run(args: string[], port: number) {
	const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
		env: { ...process.env, FABRIKA_PORT: String(port), FABRIKA_SESSION_ID: 's_int' },
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
	const port = 19810
	server = startMockDaemon({
		port,
		phaseState: {},
		sessionsDir: '/tmp/fabrika-other-root/sessions',
		healthPid: 999_999_999,
	})

	const result = await run(['ensure-daemon'], port)
	expect(result.code).toBe(1)
	expect(result.stderr).toContain('data-root mismatch')
	expect(result.stdout).toContain('"running":false')
})

test('advance succeeds online when gate feedback is consumable', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	const port = 19811
	const phaseState = {
		...derivePhase(fx.root, offlineGateProbe),
		current: 'intake',
		index: 0,
		completed: [],
		gate: true,
		satisfied: true,
	}
	server = startMockDaemon({ port, phaseState, feedback: 'looks good, ship it' })

	const r = await run(['advance', '--dir', fx.root], port)
	expect(r.code).toBe(0)
	expect(r.stdout).toContain('OK: phase 1/8 (intake) satisfied.')
	expect(r.stdout).toContain('Next -> phase 2/8')
})

test('advance online blocks when no feedback is pending', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	const port = 19812
	const phaseState = {
		current: 'intake',
		index: 0,
		completed: [],
		reads: [],
		produces: ['.fabrika/intent/brief.md'],
		gate: true,
		satisfied: true,
	}
	server = startMockDaemon({ port, phaseState, feedback: null })

	const r = await run(['advance', '--dir', fx.root], port)
	expect(r.code).toBe(1)
	expect(r.stderr).toContain('no submitted feedback to consume')
})

test('BUG A: next sends the sessionId to /api/phase so the daemon can evaluate the gate', async () => {
	fx = makeFixture()
	fx.write('.fabrika/intent/brief.md', '# brief')

	const port = 19814
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
	server = startMockDaemon({
		port,
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

	const port = 19815
	let captured: URLSearchParams | null = null
	const phaseState = {
		...derivePhase(fx.root, offlineGateProbe),
		current: 'intake',
		index: 0,
		completed: [],
		gate: true,
		satisfied: true,
	}
	server = startMockDaemon({
		port,
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
	const port = 19813
	const phaseState = {
		current: 'flows',
		index: 2,
		completed: ['intake', 'vision'],
		reads: ['.fabrika/intent/brief.md'],
		produces: ['.fabrika/architecture/flows/*.flow.md'],
		gate: true,
		satisfied: false,
	}
	server = startMockDaemon({ port, phaseState })

	const r = await run(['next', '--dir', fx.root], port)
	expect(r.stdout).toContain('## Phase 3/8 - User flows')
	expect(r.stdout).toContain('intake ✓')
	expect(r.stdout).toContain('vision ✓')
})

test('gate open --view sends the exact named view, not a containing directory', async () => {
	const gatesDir = mkdtempSync(join(tmpdir(), 'fabrika-gates-'))
	writeFileSync(join(gatesDir, 'brief.jsx'), "<Section title='B'>x</Section>")
	writeFileSync(join(gatesDir, 'vision.jsx'), "<Section title='V'>y</Section>")

	const port = 19816
	const capture: { pushed: Record<string, unknown> | null } = { pushed: null }
	const phaseState = { current: 'vision', index: 1, completed: ['intake'], reads: [], produces: [], gate: true, satisfied: false }
	server = startMockDaemon({
		port,
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
	], 19817)
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
	], 19818)
	expect(directoryAsView.code).toBe(1)
	expect(directoryAsView.stderr).toContain('--view must be a file')

	rmSync(gatesDir, { recursive: true, force: true })
})
