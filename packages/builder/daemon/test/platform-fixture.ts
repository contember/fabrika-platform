import type { DeviceAuthorizationConsent, DeviceAuthorizationReceipt, StartDeviceAuthorizationInput } from '@fabrika/auth-core'
import { parseStartDeviceAuthorizationInput } from '@fabrika/auth-core'
import type { AppDto, BuilderConnectionReceiptDto } from '@fabrika/control-contract'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { BUILDER_DAEMON_HOST } from '../../shared/urls'
import { BuilderPlatform, type BuilderPlatformOptions } from '../src/platform'

const record = z.record(z.unknown()).parse
const text = z.string().min(1).max(8192).parse

export const ATTEMPT = '01996a7a-1111-7111-8111-111111111111'
export const TOKEN = 'px_builder-fixture-machine-secret'

export async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(10)
	}
	throw new Error('Fixture did not reach expected state')
}

export function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'builder-platform-'))
	const root = join(directory, 'project')
	mkdirSync(join(root, '.fabrika'), { recursive: true })
	mkdirSync(join(directory, 'keys'), { mode: 0o700 })
	const id = 'fixture-session'
	writeFileSync(join(root, '.fabrika', 'config.json'), JSON.stringify({ profile: 'app', sessionId: id, createdAt: '2026-09-21T10:00:00.000Z' }))
	let now = 1_800_000_000
	const sleeps: number[] = []
	const waiting: (() => void)[] = []
	let started: StartDeviceAuthorizationInput | null = null
	let redemption: string | null = null
	let exchanges = 0
	let polls = 0
	let provider = 'zerops'
	let redirectTo: string | null = null
	let consentAudience = 'vozka'
	let consentPermissions: string[] | null = null
	let mode: 'approved' | 'pending' | 'denied' | 'issued' | 'already_issued' | 'wrong_scope' = 'approved'
	const calls: { method: string; input: Record<string, unknown> }[] = []
	const app: AppDto = {
		id: 'sample',
		repoUrl: 'https://github.com/example/sample',
		defaultBranch: 'main',
		workerDir: null,
		buildCmd: null,
		configPath: null,
		githubConnectionId: null,
		githubInstallationId: null,
		createdAt: now,
	}
	const receipt: BuilderConnectionReceiptDto = {
		version: 1,
		attemptId: ATTEMPT,
		provider: 'zerops',
		app,
		environment: { env: 'dev', namespaceId: 'ns', domain: 'sample.example.test', publicOrigin: 'https://sample.example.test', triggerRef: 'main' },
		createdAt: now,
	}
	let environments: unknown[] = []
	let refusePut = false
	let runStatus = 'succeeded'
	let runSha: string | null = null
	let requestedSha = ''
	let runGets = 0
	let failRunRead = false
	let failSubmissionResponse = false
	let submissionBarrier: Promise<void> | null = null
	function consent(): DeviceAuthorizationConsent {
		if (!started) throw new Error('Not started')
		return {
			consentId: '01996a7a-2222-7222-8222-222222222222',
			app: consentAudience,
			label: started.label,
			permissions: consentPermissions ?? started.permissions,
			scope: { type: 'app', value: mode === 'wrong_scope' ? 'other' : app.id },
			keyExpiresAt: 1_800_000_000 + 2592000,
		}
	}
	function issued(): DeviceAuthorizationReceipt {
		return {
			attemptId: ATTEMPT,
			consent: consent(),
			credentialId: '01996a7a-3333-7333-8333-333333333333',
			principalId: '01996a7a-4444-7444-8444-444444444444',
			issuedAt: now,
			revokedAt: null,
		}
	}
	function run() {
		return { id: 'run-1', appId: app.id, env: 'dev', ref: requestedSha, commitSha: runSha ?? requestedSha, status: runStatus }
	}
	const server = Bun.serve({
		port: 0,
		hostname: BUILDER_DAEMON_HOST,
		async fetch(req): Promise<Response> {
			const path = new URL(req.url).pathname
			if (path === '/.well-known/fabrika-builder') return Response.json({ version: 1, controlOrigin: origin, iamIssuer: origin, provider })
			const body = record(await req.json())
			if (path === '/auth/device/start') {
				started = parseStartDeviceAuthorizationInput(body)
				if (!started) return Response.json({ ok: false, reason: 'invalid_input' })
				return Response.json({ ok: true, attemptId: ATTEMPT, expiresAt: now + 600, pollIntervalSeconds: 3 })
			}
			if (path === '/auth/device/poll' || path === '/auth/device/exchange') {
				redemption = text(body['redemptionVerifier'])
				if (createHash('sha256').update(redemption).digest('base64url') !== started?.redemptionChallenge || body['attemptId'] !== ATTEMPT) {
					return Response.json({ ok: false, reason: 'invalid_attempt' })
				}
				if (path.endsWith('/poll')) {
					polls++
					return Response.json(
						mode === 'pending'
							? { ok: true, status: 'pending', expiresAt: now + 300 }
							: mode === 'denied'
							? { ok: true, status: 'denied' }
							: mode === 'issued'
							? { ok: true, status: 'issued', receipt: issued() }
							: { ok: true, status: 'approved', consent: consent() },
					)
				}
				exchanges++
				if (body['consentId'] !== consent().consentId) return Response.json({ ok: false, reason: 'consent_mismatch' })
				return Response.json(
					mode === 'already_issued' ? { ok: false, reason: 'already_issued', receipt: issued() } : { ok: true, token: TOKEN, receipt: issued() },
				)
			}
			if (path === '/api/rpc') {
				if (redirectTo) return Response.redirect(redirectTo, 307)
				if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return Response.json({ error: 'wrong credential' }, { status: 401 })
				const method = text(body['method']), input = record(body['input'])
				calls.push({ method, input })
				switch (method) {
					case 'builderConnections.getReceipt':
						return Response.json({ result: receipt })
					case 'apps.get':
						return Response.json({ result: app })
					case 'apps.environments.list':
						return Response.json({ result: { items: environments } })
					case 'apps.environments.put': {
						if (refusePut) return Response.json({ error: { message: TOKEN } }, { status: 500 })
						const environment = { ...record(input['environment']), appId: input['appId'], env: input['env'], provider: 'zerops', createdAt: now }
						environments = [environment]
						return Response.json({ result: environment })
					}
					case 'deploy':
						requestedSha = text(input['ref'])
						await submissionBarrier
						if (failSubmissionResponse) return Response.json({ error: TOKEN }, { status: 503 })
						return Response.json({ result: run() })
					case 'runs.get':
						runGets++
						if (failRunRead) return Response.json({ error: TOKEN }, { status: 503 })
						return Response.json({ result: run() })
				}
			}
			return new Response(null, { status: 404 })
		},
	})
	const origin: string = `http://${BUILDER_DAEMON_HOST}:${server.port}`
	const options: BuilderPlatformOptions = {
		stateDir: join(directory, 'state'),
		credentialDir: join(directory, 'keys'),
		dataDir: join(directory, 'data'),
		now: () => now,
		sleep: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				sleeps.push(ms)
				const abort = () => reject(new Error('Stopped'))
				signal.addEventListener('abort', abort, { once: true })
				waiting.push(() => {
					signal.removeEventListener('abort', abort)
					if (!signal.aborted) {
						now += ms / 1000
						resolve()
					}
				})
			}),
	}
	let platform = new BuilderPlatform(() => undefined, options)
	platform.register(id, root)
	return {
		directory,
		root,
		id,
		origin,
		options,
		calls,
		sleeps,
		app,
		get platform() {
			return platform
		},
		get started() {
			return started
		},
		get redemption() {
			return redemption
		},
		get exchanges() {
			return exchanges
		},
		get polls() {
			return polls
		},
		get runGets() {
			return runGets
		},
		set mode(value: typeof mode) {
			mode = value
		},
		set provider(value: string) {
			provider = value
		},
		set redirectTo(value: string | null) {
			redirectTo = value
		},
		set consentAudience(value: string) {
			consentAudience = value
		},
		set consentPermissions(value: string[]) {
			consentPermissions = value
		},
		set refusePut(value: boolean) {
			refusePut = value
		},
		set runStatus(value: string) {
			runStatus = value
		},
		set runSha(value: string | null) {
			runSha = value
		},
		set failRunRead(value: boolean) {
			failRunRead = value
		},
		set failSubmissionResponse(value: boolean) {
			failSubmissionResponse = value
		},
		pauseSubmission() {
			const gate = Promise.withResolvers<void>()
			submissionBarrier = gate.promise
			return gate.resolve
		},
		set environments(value: unknown[]) {
			environments = value
		},
		tick() {
			waiting.shift()?.()
		},
		advance(seconds: number) {
			now += seconds
		},
		async connect() {
			await platform.connect(id, origin)
			waiting.shift()?.()
			await until(() => platform.status(id).pairing?.status === 'connected')
		},
		restart() {
			platform.stop()
			platform = new BuilderPlatform(() => undefined, options)
			return platform
		},
		config() {
			return record(JSON.parse(readFileSync(join(root, '.fabrika', 'config.json'), 'utf8')))
		},
		close() {
			platform.stop()
			server.stop(true)
			rmSync(directory, { recursive: true, force: true })
		},
	}
}

export type PlatformFixture = ReturnType<typeof fixture>

export function git(root: string, ...args: string[]): string {
	const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
	if (result.exitCode !== 0) throw new Error(`Fixture Git failed: ${result.stderr.toString()}`)
	return result.stdout.toString().trim()
}

export function source(f: PlatformFixture, extraCode = ''): string {
	const bare = join(f.directory, 'remote.git')
	mkdirSync(bare)
	git(bare, 'init', '--bare', '--initial-branch=main')
	git(f.root, 'init', '--initial-branch=main')
	git(f.root, 'config', 'user.email', 'test@example.test')
	git(f.root, 'config', 'user.name', 'Builder Test')
	git(f.root, 'config', `url.${bare}.insteadOf`, 'https://github.com/example/sample')
	git(f.root, 'remote', 'add', 'origin', 'https://github.com/example/sample')
	writeFileSync(join(f.root, '.gitignore'), '.fabrika/\n.env\n')
	writeFileSync(
		join(f.root, 'fabrika.config.ts'),
		`import { defineApp } from ${
			JSON.stringify(import.meta.resolve('@fabrika/provider-zerops'))
		}\n${extraCode}\nexport default defineApp({ id: 'sample', target: { platform: 'zerops', services: () => [{ hostname: 'app', type: 'alpine/bun@1.3' }] } })\n`,
	)
	writeFileSync(join(f.root, 'zerops.yaml'), 'zerops:\n  - setup: app\n    run:\n      base: alpine/bun@1.3\n      start: bun server.ts\n')
	git(f.root, 'add', '.gitignore', 'fabrika.config.ts', 'zerops.yaml')
	git(f.root, 'commit', '-m', 'test source')
	git(f.root, 'push', 'origin', 'HEAD:main')
	return git(f.root, 'rev-parse', 'HEAD')
}
