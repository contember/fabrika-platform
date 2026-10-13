import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { PHASES } from '../../shared/phases'
import { builderDaemonUrl } from '../../shared/urls'
import { type RunningDaemon, startDaemon } from '../src/index'
import { derivePhaseState } from '../src/phases'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let daemon: RunningDaemon
let base: string
let sessionsDir: string

beforeAll(() => {
	sessionsDir = mkdtempSync(join(tmpdir(), 'fabrika-daemon-sessions-'))
	daemon = startDaemon({ port: 0, sessionsDir })
	base = builderDaemonUrl(daemon.port)
})

afterAll(() => {
	daemon.stop()
	rmSync(sessionsDir, { recursive: true, force: true })
})

describe('daemon http endpoints', () => {
	test('GET /health responds with ok + version + sessions', async () => {
		const res = await fetch(`${base}/health`)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(typeof body.version).toBe('string')
		expect(body.pid).toBe(process.pid)
		expect(body.sessionsDir).toBe(sessionsDir)
		expect(body.dataDir).toBe(join(sessionsDir, '..'))
		expect(Array.isArray(body.sessions)).toBe(true)
	})

	test('GET /api/phase derives phase state from a .fabrika/ dir', async () => {
		const repo = mkdtempSync(join(tmpdir(), 'fabrika-repo-'))
		const fabrikaDir = join(repo, '.fabrika')
		mkdirSync(fabrikaDir, { recursive: true })

		const res = await fetch(`${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}`)
		expect(res.status).toBe(200)
		const state = await res.json()
		expect(state.current).toBe('intake')
		expect(state.index).toBe(1)
		expect(state.completed).toEqual([])
		expect(state.gate).toBe(true)
		expect(state.satisfied).toBe(false)

		rmSync(repo, { recursive: true, force: true })
	})

	test('GET /api/phase without root → 400', async () => {
		const res = await fetch(`${base}/api/phase`)
		expect(res.status).toBe(400)
	})

	test('POST /api/session/:id/plan (gate open) compiles + creates a revision', async () => {
		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-canvas-'))
		writeFileSync(join(canvasDir, 'view.jsx'), "<Section title='Hi'>x</Section>")

		const sessionId = 'smoke-session'
		const res = await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ directory: canvasDir, projectRoot: canvasDir, gate: 'intake' }),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(body.revision).toBe(1)
		expect(body.gate).toBe('intake')
		expect(body.browserUrl).toBe(`${base}/s/${sessionId}`)
		expect(body.canvasFiles).toContain('view.jsx')

		const meta = await (await fetch(`${base}/api/session/${sessionId}/meta`)).json()
		expect(meta.currentRevision).toBe(1)
		expect(meta.revisions[0].label).toBe('intake')
		expect(meta.revisions[0].canvasScope).toEqual({ kind: 'directory' })

		const js = await fetch(`${base}/api/session/${sessionId}/canvas/view.js`)
		expect(js.status).toBe(200)
		expect(js.headers.get('content-type')).toContain('javascript')

		rmSync(canvasDir, { recursive: true, force: true })
	})

	test('POST /plan with view records and compiles exactly that file', async () => {
		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-single-canvas-'))
		const brief = join(canvasDir, 'brief.jsx')
		const vision = join(canvasDir, 'vision.jsx')
		writeFileSync(brief, "<Section title='Old'>old questions</Section>")
		writeFileSync(vision, "<Section title='Current'>current questions</Section>")

		const sessionId = 'single-view-session'
		const res = await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ view: vision, projectRoot: canvasDir, gate: 'vision' }),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.canvasFiles).toEqual(['vision.jsx'])

		const meta = await (await fetch(`${base}/api/session/${sessionId}/meta`)).json()
		expect(meta.canvasFiles).toEqual(['vision.jsx'])
		expect(meta.revisions[0].canvasFiles).toEqual([{ filename: 'vision.jsx' }])
		expect(meta.revisions[0].canvasScope).toEqual({ kind: 'view', filename: 'vision.jsx' })

		expect((await fetch(`${base}/api/session/${sessionId}/canvas/vision.js`)).status).toBe(200)
		expect((await fetch(`${base}/api/session/${sessionId}/canvas/brief.js`)).status).toBe(404)

		rmSync(canvasDir, { recursive: true, force: true })
	})

	test('POST /plan rejects ambiguous view + directory input', async () => {
		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-ambiguous-canvas-'))
		const view = join(canvasDir, 'view.jsx')
		writeFileSync(view, "<Section title='X'>x</Section>")

		const res = await fetch(`${base}/api/session/ambiguous-source/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ view, directory: canvasDir, projectRoot: canvasDir, gate: 'intake' }),
		})
		expect(res.status).toBe(400)
		expect((await res.json()).error).toContain('exactly one')

		rmSync(canvasDir, { recursive: true, force: true })
	})

	test('a pushed-but-unanswered gate does NOT complete its phase', async () => {
		const repo = mkdtempSync(join(tmpdir(), 'fabrika-gate-repo-'))
		const fabrikaDir = join(repo, '.fabrika')
		mkdirSync(join(fabrikaDir, 'intent'), { recursive: true })
		writeFileSync(join(fabrikaDir, 'intent', 'brief.md'), '# Brief\ncontent')

		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-gate-canvas-'))
		writeFileSync(join(canvasDir, 'brief.jsx'), "<Section title='Brief'>x</Section>")

		const sessionId = 'gate-unanswered-session'
		const open = await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ directory: canvasDir, projectRoot: repo, gate: 'intake' }),
		})
		expect(open.status).toBe(200)

		const url = `${base}/api/phase?root=${encodeURIComponent(fabrikaDir)}&session=${sessionId}`
		const state = await (await fetch(url)).json()
		expect(state.current).toBe('intake')
		expect(state.completed).not.toContain('intake')

		rmSync(repo, { recursive: true, force: true })
		rmSync(canvasDir, { recursive: true, force: true })
	})

	test('POST /api/build/event + history echoes the event', async () => {
		const res = await fetch(`${base}/api/build/event`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ issue: 'ISSUE-001', status: 'running', message: 'building' }),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.ok).toBe(true)
		expect(body.event.status).toBe('running')
		expect(typeof body.event.at).toBe('string')
		const recovered = await fetch(`${base}/api/build/event`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'info', issue: 42, message: null, at: 'legacy time', data: { extension: true }, ignored: true }),
		})
		expect(await recovered.json()).toEqual({ ok: true, event: { status: 'info', at: 'legacy time', data: { extension: true } } })
		const rejected = await fetch(`${base}/api/build/event`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'credential-secret' }),
		})
		expect(rejected.status).toBe(400)
		expect(await rejected.json()).toEqual({ error: 'Invalid or missing status' })
	})

	test('GET /api/sessions lists the created session', async () => {
		const res = await fetch(`${base}/api/sessions`)
		expect(res.status).toBe(200)
		const list: unknown = await res.json()
		expect(Array.isArray(list) && list.some((entry: unknown) => isRecord(entry) && entry['id'] === 'smoke-session')).toBe(true)
	})

	test('GET /api/session/:id/artifact reads a project file (sandboxed)', async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'fabrika-proj-'))
		mkdirSync(join(projectRoot, '.fabrika', 'architecture'), { recursive: true })
		writeFileSync(join(projectRoot, '.fabrika', 'architecture', 'design.md'), '# tokens\n:root{--x:1}')
		const canvasDir = join(projectRoot, '.gates', 'design')
		mkdirSync(canvasDir, { recursive: true })
		writeFileSync(join(canvasDir, 'view.jsx'), "<Section title='D'>x</Section>")

		const sessionId = 'artifact-session'
		await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ directory: canvasDir, projectRoot, gate: 'design' }),
		})

		const ok = await fetch(
			`${base}/api/session/${sessionId}/artifact?path=${encodeURIComponent('.fabrika/architecture/design.md')}`,
		)
		expect(ok.status).toBe(200)
		const body = await ok.json()
		expect(body.content).toContain('--x:1')

		const escape = await fetch(
			`${base}/api/session/${sessionId}/artifact?path=${encodeURIComponent('../../../etc/passwd')}`,
		)
		expect(escape.status).toBe(403)

		expect((await fetch(`${base}/api/session/${sessionId}/artifact?path=nope.md`)).status).toBe(404)
		expect((await fetch(`${base}/api/session/${sessionId}/artifact`)).status).toBe(400)
		expect((await fetch(`${base}/api/session/ghost/artifact?path=x`)).status).toBe(404)

		rmSync(projectRoot, { recursive: true, force: true })
	})

	test('re-pushing a session preserves its original projectRoot', async () => {
		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-pr-'))
		writeFileSync(join(canvasDir, 'view.jsx'), "<Section title='A'>x</Section>")
		const sessionId = 'projectroot-session'

		const push = (projectRoot: string) =>
			fetch(`${base}/api/session/${sessionId}/plan`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ directory: canvasDir, projectRoot, gate: 'intake' }),
			})

		await push('/tmp/original-root')
		await push('/tmp/some-other-cwd')

		const meta = await (await fetch(`${base}/api/session/${sessionId}/meta`)).json()
		expect(meta.projectRoot).toBe('/tmp/original-root')

		rmSync(canvasDir, { recursive: true, force: true })
	})

	test('GET /api/session/:id/skeletons parses opice metadata (brace-matched url)', async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), 'fabrika-sk-'))
		const tb = join(projectRoot, 'tests', 'browser')
		mkdirSync(tb, { recursive: true })
		writeFileSync(
			join(tb, 'checkout.test.ts'),
			"import { browserTest, step, invariant } from '@opice/harness'\n"
				+ "const BASE = process.env.APP_URL ?? 'http://localhost:5173'\n"
				+ "browserTest({ name: 'checks out', url: `${BASE}/cart`, seeds: ['catalog','saved-card'], roles: ['shopper'], feature: 'F-CHK-02' }, async () => {\n"
				+ "  await step('pay', { intent: 'x' })\n  await invariant.todo('masked', 'h')\n})\n",
		)
		const canvasDir = join(projectRoot, '.gates', 'skeletons')
		mkdirSync(canvasDir, { recursive: true })
		writeFileSync(join(canvasDir, 'g.jsx'), "<Section title='S'>x</Section>")

		const sessionId = 'skeletons-session'
		await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ directory: canvasDir, projectRoot, gate: 'skeletons' }),
		})

		const { skeletons } = await (await fetch(`${base}/api/session/${sessionId}/skeletons`)).json()
		expect(skeletons.length).toBe(1)
		const s = skeletons[0]
		expect(s.name).toBe('checks out')
		expect(s.url).toBe('/cart') // template literal `${BASE}/cart` brace-matched + reduced
		expect(s.seeds).toEqual(['catalog', 'saved-card'])
		expect(s.roles).toEqual(['shopper'])
		expect(s.pending).toBeGreaterThan(0) // pending step + invariant.todo

		rmSync(projectRoot, { recursive: true, force: true })
	})

	test('gate answers persist server-side (PUT then GET responses)', async () => {
		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-resp-'))
		writeFileSync(join(canvasDir, 'view.jsx'), "<Section title='R'>x</Section>")
		const sessionId = 'responses-session'
		await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ directory: canvasDir, projectRoot: canvasDir, gate: 'intake' }),
		})

		const empty = await (await fetch(`${base}/api/session/${sessionId}/revision/1/responses`)).json()
		expect(empty.responses).toBeNull()

		const payload = {
			annotations: [],
			generalNote: 'hi',
			responses: [['k', { id: 'k', type: 'future-widget', value: { extension: ['v'] }, custom: true }]],
			feedbackEntries: [],
			futureDraft: { nested: ['preserve', null] },
		}
		const put = await fetch(`${base}/api/session/${sessionId}/revision/1/responses`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})
		expect(put.status).toBe(200)

		const got = await (await fetch(`${base}/api/session/${sessionId}/revision/1/responses`)).json()
		expect(got.responses.generalNote).toBe('hi')
		expect(got.responses.responses[0][0]).toBe('k')
		expect(got.responses).toEqual(payload)

		const ghost = await fetch(`${base}/api/session/ghost/revision/1/responses`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(ghost.status).toBe(404)

		rmSync(canvasDir, { recursive: true, force: true })
	})

	test('POST /api/session/:id/reset drops the session (memory + meta)', async () => {
		const canvasDir = mkdtempSync(join(tmpdir(), 'fabrika-reset-'))
		writeFileSync(join(canvasDir, 'view.jsx'), "<Section title='X'>x</Section>")
		const sessionId = 'reset-session'
		await fetch(`${base}/api/session/${sessionId}/plan`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ directory: canvasDir, projectRoot: canvasDir, gate: 'intake' }),
		})

		expect((await fetch(`${base}/api/session/${sessionId}/meta`)).status).toBe(200)

		const reset = await fetch(`${base}/api/session/${sessionId}/reset`, { method: 'POST' })
		expect(reset.status).toBe(200)
		expect((await reset.json()).existed).toBe(true)

		expect((await fetch(`${base}/api/session/${sessionId}/meta`)).status).toBe(404)

		const noop = await fetch(`${base}/api/session/${sessionId}/reset`, { method: 'POST' })
		expect((await noop.json()).existed).toBe(false)

		rmSync(canvasDir, { recursive: true, force: true })
	})
})

describe('derivePhaseState (filesystem fixture)', () => {
	function freshFabrika(): string {
		return join(mkdtempSync(join(tmpdir(), 'fabrika-derive-')), '.fabrika')
	}

	test('empty → intake', () => {
		const dir = freshFabrika()
		const state = derivePhaseState(dir)
		expect(state.current).toBe('intake')
		rmSync(dirname(dir), { recursive: true, force: true })
	})

	test('brief present (no oracle) → advances past intake to vision', () => {
		const dir = freshFabrika()
		mkdirSync(join(dir, 'intent'), { recursive: true })
		writeFileSync(join(dir, 'intent', 'brief.md'), '# Brief\nsome content')
		const state = derivePhaseState(dir)
		expect(state.completed).toContain('intake')
		expect(state.current).toBe('vision')
		rmSync(dirname(dir), { recursive: true, force: true })
	})

	test('empty file does not satisfy produces', () => {
		const dir = freshFabrika()
		mkdirSync(join(dir, 'intent'), { recursive: true })
		writeFileSync(join(dir, 'intent', 'brief.md'), '') // empty → not satisfied
		const state = derivePhaseState(dir)
		expect(state.current).toBe('intake')
		rmSync(dirname(dir), { recursive: true, force: true })
	})

	test('gate oracle blocks completion when feedback is unconsumed', () => {
		const dir = freshFabrika()
		mkdirSync(join(dir, 'intent'), { recursive: true })
		writeFileSync(join(dir, 'intent', 'brief.md'), '# Brief')
		const oracle = {
			getLatestUnconsumedFeedback: () => ({ revision: 1, feedback: 'fix this' }),
			hasGateRevision: () => true,
		}
		const state = derivePhaseState(dir, 'sess', oracle)
		expect(state.current).toBe('intake')
		expect(state.satisfied).toBe(true)
		rmSync(dirname(dir), { recursive: true, force: true })
	})

	test('PHASES table has 8 ordered phases', () => {
		expect(PHASES.length).toBe(8)
		expect(PHASES.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
		expect(PHASES[0]!.id).toBe('intake')
		expect(PHASES[7]!.id).toBe('build')
	})
})
