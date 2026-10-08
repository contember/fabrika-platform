import { afterEach, expect, test } from 'bun:test'
import { readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BuilderPlatformStatus, BuilderProjectConnection } from '../../shared'
import { type Fixture, makeFixture } from './helpers'

const bin = resolve(import.meta.dir, '../src/bin.ts')
let fixture: Fixture | undefined
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
	server?.stop(true)
	fixture?.cleanup()
})

const connection: BuilderProjectConnection = {
	controlOrigin: 'https://control.example',
	iamIssuer: 'https://iam.example',
	receipt: {
		version: 1,
		attemptId: '019965f0-0000-7000-8000-000000000001',
		provider: 'zerops',
		createdAt: 1,
		app: {
			id: 'demo',
			repoUrl: 'https://github.com/example/demo',
			defaultBranch: 'main',
			workerDir: null,
			buildCmd: null,
			configPath: null,
			githubInstallationId: null,
			createdAt: 1,
		},
		environment: { env: 'production', namespaceId: 'space', domain: 'demo.example', publicOrigin: 'https://demo.example', triggerRef: null },
	},
}

function setup() {
	fixture = makeFixture(false)
	const fx = fixture
	const config = { profile: 'zerops-app', sessionId: 'configured-session', createdAt: '2026-09-21T00:00:00Z' }
	fx.write('.fabrika/config.json', JSON.stringify(config))
	const requests: { path: string; method: string; body: unknown }[] = []
	const status: BuilderPlatformStatus = {
		sessionId: config.sessionId,
		projectRoot: fx.root,
		connection: null,
		credential: { available: false, expiresAt: null },
		previewUrl: null,
		deployment: null,
		pairing: null,
	}
	let malformed = false
	let refused = false
	let onPlatform: (() => void) | undefined
	server = Bun.serve({
		port: 0,
		hostname: 'localhost',
		async fetch(request) {
			const path = new URL(request.url).pathname
			if (path === '/health') return Response.json({ ok: true, pid: process.pid, sessionsDir: join(fx.root, 'data', 'sessions') })
			const body = await request.text()
			requests.push({ path, method: request.method, body: body ? JSON.parse(body) : null })
			if (path.endsWith('/platform')) onPlatform?.()
			if (refused) return Response.json({ error: 'SECRET_PROOF' }, { status: 400 })
			if (path.endsWith('/connect')) {
				if (status.pairing) return Response.json({ error: 'active operation SECRET_PROOF' }, { status: 409 })
				status.pairing = { status: 'pending', authorizationUrl: 'https://control.example/builder/connect#approval=SECRET_PROOF', expiresAt: 9999999999 }
			}
			return Response.json(malformed ? { secret: 'SECRET_PROOF' } : status)
		},
	})
	const port = server.port
	async function run(args: string[]) {
		const process = Bun.spawn(['bun', bin, ...args], {
			cwd: fx.root,
			env: { ...Bun.env, FABRIKA_PORT: String(port), FABRIKA_DATA_DIR: join(fx.root, 'data'), FABRIKA_SESSION_ID: 'ignored-override' },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
		expect(stdout + stderr).not.toContain('SECRET_PROOF')
		return { stdout, stderr, code }
	}
	return {
		fx,
		config,
		requests,
		status,
		run,
		malformed: () => {
			malformed = true
		},
		refused: () => {
			refused = true
		},
		onPlatform: (callback: () => void) => {
			onPlatform = callback
		},
	}
}

test('platform commands use registered config identity before canvas and redact approval proof', async () => {
	const f = setup()
	const result = await f.run(['connect', '--url=https://control.example', '--no-open', '--json'])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).pairing).toEqual({ status: 'pending', expiresAt: 9999999999 })
	expect(JSON.parse(result.stdout).dashboardUrl).toContain('/s/configured-session')
	expect(f.requests).toEqual([
		{ path: '/api/project/configured-session/register', method: 'POST', body: { projectRoot: f.fx.root } },
		{ path: '/api/project/configured-session/connect', method: 'POST', body: { controlOrigin: 'https://control.example' } },
	])
	f.requests.length = 0
	expect((await f.run(['status', '--json'])).code).toBe(0)
	expect(f.requests.map(r => r.path.split('/').at(-1))).toEqual(['register', 'platform'])
	expect((await f.run(['preview', '--url=http://localhost:4321'])).code).toBe(0)
	expect(f.requests.at(-1)?.body).toEqual({ url: 'http://localhost:4321/' })
	expect((await f.run(['preview', '--clear'])).code).toBe(0)
	expect(f.requests.at(-1)?.body).toEqual({ url: null })
	expect((await f.run(['disconnect'])).stderr).toContain('Revoke')

	for (const command of ['connect', 'status', 'disconnect', 'deploy', 'preview', 'init']) {
		f.requests.length = 0
		expect((await f.run([command, '--help'])).code).toBe(0)
		expect(f.requests).toEqual([])
	}
})

test('malformed config and incompatible init refuse before writing; repeat init preserves binding and artifacts', async () => {
	const f = setup()
	f.fx.write('.fabrika/config.json', '{"secret":"SECRET_PROOF"}')
	const before = readFileSync(join(f.fx.root, '.fabrika/config.json'), 'utf8')
	expect((await f.run(['init', '--no-daemon'])).code).toBe(1)
	expect(readFileSync(join(f.fx.root, '.fabrika/config.json'), 'utf8')).toBe(before)
	f.fx.write('.fabrika/config.json', JSON.stringify({ ...f.config, connection }))
	f.fx.write('.fabrika/intent/brief.md', 'keep this')
	expect((await f.run(['init', '--url=https://control.example', '--no-daemon'])).code).toBe(1)
	expect((await f.run(['init', '--profile=cf-lightweight', '--url=https://control.example'])).code).toBe(1)
	expect((await f.run(['init', '--url=https://control.example', '--no-open'])).code).toBe(0)
	expect(f.requests.map(r => r.path.split('/').at(-1))).toEqual(['register'])
	expect(JSON.parse(readFileSync(join(f.fx.root, '.fabrika/config.json'), 'utf8')).connection).toEqual(connection)
	expect(readFileSync(join(f.fx.root, '.fabrika/intent/brief.md'), 'utf8')).toBe('keep this')
	const next = await f.run(['next', '--json'])
	expect(JSON.parse(next.stdout).platform.environment.namespaceId).toBe('space')
})

test('wait failures and timeout retain run id; malformed and HTTP errors never echo response bodies', async () => {
	const f = setup()
	f.status.deployment = { status: 'failed', runId: 'run-123', commitSha: 'abc', message: 'SECRET_PROOF', appUrl: null, consoleUrl: null }
	for (const status of ['failed', 'cancelled', 'running', 'succeeded']) {
		if (status !== 'failed' && status !== 'cancelled' && status !== 'running' && status !== 'succeeded') continue
		f.status.deployment.status = status
		const result = await f.run(['deploy', '--wait', '--timeout=0.01', '--json'])
		expect(result.code).toBe(status === 'succeeded' ? 0 : 1)
		expect(JSON.parse(result.stdout).deployment.runId).toBe('run-123')
		expect(JSON.parse(result.stdout).outcome).toBe(status === 'running' ? 'timed_out' : status)
	}
	f.malformed()
	expect((await f.run(['status'])).code).toBe(1)
	f.refused()
	expect((await f.run(['connect', '--url=https://control.example', '--no-open'])).code).toBe(1)
})

test('connected init defaults to zerops-app and validates options before registration', async () => {
	const f = setup()
	unlinkSync(join(f.fx.root, '.fabrika/config.json'))
	expect((await f.run(['init', '--url=https://control.example', '--profile=cf-lightweight', '--no-open'])).code).toBe(1)
	expect(f.requests).toEqual([])
	const result = await f.run(['init', '--url=https://control.example', '--no-open'])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).profile).toBe('zerops-app')
	expect(f.requests.map(r => r.path.split('/').at(-1))).toEqual(['reset', 'register', 'connect'])
	f.requests.length = 0
	for (
		const args of [['deploy', '--timeout=1'], ['deploy', '--wait', '--timeout=NaN'], ['status', '--url=https://control.example'], [
			'preview',
			'--clear',
			'--url=http://localhost:4321',
		]]
	) {
		expect((await f.run(args)).code).toBe(1)
	}
	expect(f.requests).toEqual([])
})

test('wait polls status without retriggering and preserves run identity when polling fails', async () => {
	const f = setup()
	f.status.deployment = { status: 'running', runId: 'run-poll', commitSha: 'abc', message: null, appUrl: null, consoleUrl: null }
	f.onPlatform(() => {
		if (f.status.deployment) f.status.deployment.status = 'succeeded'
	})
	const result = await f.run(['deploy', '--wait', '--timeout=5'])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).outcome).toBe('succeeded')
	expect(f.requests.map(r => r.path.split('/').at(-1))).toEqual(['register', 'deploy', 'platform'])
	f.status.deployment.status = 'running'
	f.onPlatform(f.refused)
	const failed = await f.run(['deploy', '--wait', '--timeout=5'])
	expect(failed.code).toBe(1)
	expect(JSON.parse(failed.stdout).outcome).toBe('poll_failed')
	expect(JSON.parse(failed.stdout).deployment.runId).toBe('run-poll')
})

test('repeat connected init reuses pending and approved pairing without a second connect', async () => {
	const f = setup()
	const args = ['init', '--url=https://control.example', '--no-open', '--json']
	expect((await f.run(args)).code).toBe(0)
	const pending = await f.run(args)
	expect(pending.code).toBe(0)
	expect(JSON.parse(pending.stdout).platform.pairing).toEqual({ status: 'pending', expiresAt: 9999999999 })
	expect(JSON.parse(pending.stdout).browserUrl).toContain('/s/configured-session')
	expect(pending.stdout).not.toContain('authorizationUrl')
	expect(f.requests.map(r => r.path.split('/').at(-1))).toEqual(['register', 'connect', 'register'])
	const mismatch = await f.run(['init', '--url=https://other.example', '--no-open', '--json'])
	expect(mismatch.code).toBe(1)
	expect(mismatch.stdout).toBe('')
	expect(mismatch.stderr).toContain('Disconnect explicitly')
	f.status.pairing = { status: 'approved' }
	const approved = await f.run(args)
	expect(approved.code).toBe(0)
	expect(JSON.parse(approved.stdout).platform.pairing).toEqual({ status: 'approved' })
	expect(f.requests.filter(r => r.path.endsWith('/connect'))).toHaveLength(1)
})
