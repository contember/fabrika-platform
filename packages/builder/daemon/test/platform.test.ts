import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseBuilderPlatformStatus } from '../../shared'
import { startDaemon } from '../src/index'
import { BuilderPlatform } from '../src/platform'
import { verifySource } from '../src/platform-source'
import { fixture, git, type PlatformFixture, source, TOKEN, until } from './platform-fixture'

const fixtures: PlatformFixture[] = []
function setup() {
	const f = fixture()
	fixtures.push(f)
	return f
}
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close()
})

describe('local project API and custody', () => {
	test('registers before any canvas; metadata, phase, preview and artifacts work without a revision', async () => {
		const f = setup()
		const daemon = startDaemon({ port: 0, sessionsDir: join(f.directory, 'sessions'), platform: f.options })
		const base = `http://localhost:${daemon.port}`
		try {
			const response = await fetch(`${base}/api/project/${f.id}/register`, { method: 'POST', body: JSON.stringify({ projectRoot: f.root }) })
			expect(response.status).toBe(200)
			expect(parseBuilderPlatformStatus(await response.json()).credential.available).toBe(false)
			expect(daemon.sessionManager.get(f.id)).toBeUndefined()
			const meta = await (await fetch(`${base}/api/session/${f.id}/meta`)).json()
			expect(meta.revisions).toEqual([])
			expect(meta.currentRevision).toBe(0)
			expect((await fetch(`${base}/api/phase?session=${f.id}`)).status).toBe(200)
			const preview = await fetch(`${base}/api/project/${f.id}/preview`, { method: 'POST', body: JSON.stringify({ url: 'http://localhost:6123/' }) })
			expect(parseBuilderPlatformStatus(await preview.json()).previewUrl).toBe('http://localhost:6123/')
			expect(f.config()['profile']).toBe('app')
			writeFileSync(join(f.root, 'design.md'), 'safe artifact')
			expect((await (await fetch(`${base}/api/session/${f.id}/artifact?path=design.md`)).json()).content).toBe('safe artifact')
			writeFileSync(join(f.directory, 'keys', 'secret'), TOKEN, { mode: 0o600 })
			symlinkSync(join(f.directory, 'keys'), join(f.root, 'outside'))
			expect((await fetch(`${base}/api/session/${f.id}/artifact?path=outside/secret`)).status).toBe(403)
			symlinkSync(join(f.directory, 'keys', 'secret'), join(f.root, 'secret.jsx'))
			const canvas = await fetch(`${base}/api/session/${f.id}/plan`, {
				method: 'POST',
				body: JSON.stringify({ view: join(f.root, 'secret.jsx'), projectRoot: f.root }),
			})
			expect(canvas.status).toBe(400)
			expect(await canvas.text()).not.toContain(TOKEN)
			const connect = await fetch(`${base}/api/project/${f.id}/connect`, { method: 'POST', body: JSON.stringify({ controlOrigin: f.origin }) })
			expect(parseBuilderPlatformStatus(await connect.json()).pairing?.status).toBe('pending')
			f.tick()
			await until(() => f.platform.storage.credential(f.id) !== null)
			const connected = await fetch(`${base}/api/project/${f.id}/platform`)
			expect(parseBuilderPlatformStatus(await connected.json()).credential.available).toBe(true)
			const disconnect = await fetch(`${base}/api/project/${f.id}/disconnect`, { method: 'POST', body: '{}' })
			expect(parseBuilderPlatformStatus(await disconnect.json()).credential.available).toBe(false)
		} finally {
			daemon.stop()
		}
	})

	test('registration refuses root rebinding, wrong sessions, privileged roots and in-project data storage', () => {
		const f = setup()
		expect(() => f.platform.register('different-session', f.root)).toThrow()
		expect(() => f.platform.register(f.id, homedir())).toThrow()
		expect(() => f.platform.register(f.id, f.directory)).toThrow()
		const other = new BuilderPlatform(() => f.directory, f.options)
		expect(() => other.register(f.id, f.root)).toThrow()
		other.stop()
		const inProject = new BuilderPlatform(() => undefined, { ...f.options, dataDir: join(f.root, '.daemon') })
		expect(() => inProject.register(f.id, f.root)).toThrow()
		inProject.stop()
	})

	test('uses independent S256 proofs, stores only private key custody, survives restart and pins origins against config tampering', async () => {
		const f = setup()
		source(f)
		const pending = await f.platform.connect(f.id, f.origin)
		if (pending.pairing?.status !== 'pending') throw new Error('Expected pending authorization')
		const fragment = new URLSearchParams(new URL(pending.pairing.authorizationUrl).hash.slice(1))
		const approval = fragment.get('approval')
		if (!approval) throw new Error('Missing approval')
		const started = f.started
		if (!started) throw new Error('Missing IAM attempt')
		expect(Buffer.from(approval, 'base64url').length).toBe(32)
		expect(createHash('sha256').update(approval).digest('base64url')).toBe(started.approvalChallenge)
		f.tick()
		await until(() => f.platform.status(f.id).credential.available)
		expect(f.redemption).not.toBe(approval)
		expect(f.sleeps[0]).toBe(3000)
		expect(f.exchanges).toBe(1)
		const status = f.platform.status(f.id)
		expect(JSON.stringify(status)).not.toContain(TOKEN)
		expect(JSON.stringify(status)).not.toContain(f.redemption ?? 'missing')
		expect(JSON.stringify(f.config())).not.toContain(TOKEN)
		for (const file of readdirSync(join(f.directory, 'state'))) expect(readFileSync(join(f.directory, 'state', file), 'utf8')).not.toContain(TOKEN)
		const keyFile = join(f.directory, 'keys', readdirSync(join(f.directory, 'keys'))[0]!)
		expect(lstatSync(keyFile).mode & 0o777).toBe(0o600)
		expect(lstatSync(join(f.directory, 'keys')).mode & 0o777).toBe(0o700)
		const config = f.config()
		writeFileSync(
			join(f.root, '.fabrika', 'config.json'),
			JSON.stringify({
				...config,
				connection: { ...status.connection, controlOrigin: 'https://attacker.example', iamIssuer: 'https://attacker.example' },
			}),
		)
		expect(f.restart().status(f.id).connection?.controlOrigin).toBe(f.origin)
		expect(f.platform.status(f.id).credential.available).toBe(true)
		f.platform.deploy(f.id)
		await until(() => f.platform.status(f.id).deployment?.status === 'succeeded')
		await expect(f.platform.connect(f.id, f.origin)).rejects.toThrow('explicit disconnect')
		const disconnected = f.platform.disconnect(f.id)
		expect(disconnected.credential.available).toBe(false)
		expect(disconnected.pairing).toEqual({ status: 'cancelled' })
		expect(f.platform.storage.credential(f.id)).toBeNull()
	})

	test('refuses symlinked credential directories and loose permissions', async () => {
		const f = setup()
		rmSync(join(f.directory, 'keys'), { recursive: true })
		mkdirSync(join(f.directory, 'elsewhere'), { mode: 0o700 })
		symlinkSync(join(f.directory, 'elsewhere'), join(f.directory, 'keys'))
		expect(() => f.platform.status(f.id)).toThrow('Symlinks')
		rmSync(join(f.directory, 'keys'))
		mkdirSync(join(f.directory, 'keys'), { mode: 0o755 })
		expect(() => f.platform.status(f.id)).toThrow('owner-only')
		chmodSync(join(f.directory, 'keys'), 0o700)
		await f.connect()
		const path = join(f.directory, 'keys', readdirSync(join(f.directory, 'keys'))[0]!)
		rmSync(path)
		writeFileSync(join(f.directory, 'fake-key'), '{}', { mode: 0o600 })
		symlinkSync(join(f.directory, 'fake-key'), path)
		expect(() => f.platform.status(f.id)).toThrow('Symlinks')
	})

	test.each(['already_issued', 'issued', 'wrong_scope'])('%s requires explicit recovery and never remints', async (mode) => {
		const f = setup()
		if (mode !== 'already_issued' && mode !== 'issued' && mode !== 'wrong_scope') throw new Error('Invalid mode')
		f.mode = mode
		await f.platform.connect(f.id, f.origin)
		f.tick()
		await until(() => f.platform.status(f.id).pairing?.status === 'recovery_required')
		expect(f.platform.status(f.id).credential.available).toBe(false)
		expect(f.exchanges).toBe(mode === 'issued' ? 0 : 1)
		expect(f.restart().status(f.id).pairing?.status).toBe('recovery_required')
		await expect(f.platform.connect(f.id, f.origin)).rejects.toThrow()
	})

	test('unsupported providers and denied consent never exchange', async () => {
		const f = setup()
		f.provider = 'cloudflare'
		await expect(f.platform.connect(f.id, f.origin)).rejects.toThrow('Unsupported provider')
		f.provider = 'zerops'
		f.mode = 'denied'
		await f.platform.connect(f.id, f.origin)
		f.tick()
		await until(() => f.platform.status(f.id).pairing?.status === 'failed')
		expect(f.exchanges).toBe(0)
	})

	test.each(['audience', 'permissions'])('rejects altered consent %s before exchange', async (field) => {
		const f = setup()
		if (field === 'audience') f.consentAudience = 'other'
		else f.consentPermissions = ['*']
		await f.platform.connect(f.id, f.origin)
		f.tick()
		await until(() => f.platform.status(f.id).pairing?.status === 'failed')
		expect(f.exchanges).toBe(0)
		expect(f.calls).toHaveLength(0)
	})

	test('one-time credential persistence failure retains a recovery marker across restart', async () => {
		const f = setup()
		f.platform.storage.saveCredential = () => {
			throw new Error(`storage unavailable ${TOKEN}`)
		}
		await f.platform.connect(f.id, f.origin)
		f.tick()
		await until(() => f.platform.status(f.id).pairing?.status === 'recovery_required')
		expect(f.exchanges).toBe(1)
		expect(JSON.stringify(f.platform.status(f.id))).not.toContain(TOKEN)
		expect(f.restart().status(f.id).pairing?.status).toBe('recovery_required')
		expect(f.platform.status(f.id).credential.available).toBe(false)
	})

	test('credential-bearing Control requests refuse HTTP redirects', async () => {
		const f = setup()
		let leakedRequests = 0
		const sink = Bun.serve({
			port: 0,
			hostname: 'localhost',
			fetch: () => {
				leakedRequests++
				return Response.json({})
			},
		})
		try {
			f.redirectTo = `http://localhost:${sink.port}/receive`
			await f.platform.connect(f.id, f.origin)
			f.tick()
			await until(() => f.platform.status(f.id).pairing?.status === 'recovery_required')
			expect(leakedRequests).toBe(0)
			expect(f.exchanges).toBe(1)
		} finally {
			sink.stop(true)
		}
	})

	test('pending attempts poll at the protocol interval and stop with the daemon', async () => {
		const f = setup()
		f.mode = 'pending'
		await f.platform.connect(f.id, f.origin)
		f.tick()
		await until(() => f.polls === 1 && f.sleeps.length === 2)
		f.platform.stop()
		f.tick()
		await Bun.sleep(20)
		expect(f.sleeps).toEqual([3000, 3000])
		expect(f.polls).toBe(1)
		expect(f.exchanges).toBe(0)
		expect(f.restart().status(f.id).credential.available).toBe(false)
	})

	test('attempt and retained key expiry never cause automatic reminting', async () => {
		const f = setup()
		f.mode = 'pending'
		await f.platform.connect(f.id, f.origin)
		f.advance(601)
		f.tick()
		await until(() => f.platform.status(f.id).pairing?.status === 'expired')
		expect(f.exchanges).toBe(0)
		const connected = setup()
		await connected.connect()
		connected.advance(2592001)
		expect(connected.restart().status(connected.id).credential.available).toBe(false)
		expect(() => connected.platform.deploy(connected.id)).toThrow('valid credential')
		expect(connected.exchanges).toBe(1)
	})
})

describe('exact-source deployment', () => {
	test('isolates compilation, deploys exact pushed SHA and preserves latest placement on repeat PUT', async () => {
		const f = setup()
		const sha = source(f, `await Bun.write('.fabrika/compiler-env.json', JSON.stringify(process.env))`)
		writeFileSync(join(f.root, '.env'), 'FABRIKA_CONTROL_KEY=dotenv-secret\n')
		const previous = process.env['FABRIKA_CONTROL_KEY']
		process.env['FABRIKA_CONTROL_KEY'] = 'inherited-secret'
		try {
			await f.connect()
			expect(f.platform.deploy(f.id).deployment?.status).toBe('preparing')
			await until(() => f.platform.status(f.id).deployment?.status === 'succeeded' || f.platform.status(f.id).deployment?.status === 'failed')
			expect(f.platform.status(f.id).deployment).toMatchObject({
				status: 'succeeded',
				commitSha: sha,
				runId: 'run-1',
				appUrl: 'https://sample.example.test/',
			})
			const env = readFileSync(join(f.root, '.fabrika/compiler-env.json'), 'utf8')
			expect(env).not.toContain('inherited-secret')
			expect(env).not.toContain('dotenv-secret')
			expect(env).not.toContain(TOKEN)
			expect(f.calls.find((call) => call.method === 'deploy')?.input['ref']).toBe(sha)
			const first = f.calls.find((call) => call.method === 'apps.environments.put')
			if (!first) throw new Error('Missing environment PUT')
			const environment = first.input['environment']
			if (typeof environment !== 'object' || environment === null) throw new Error('Missing environment')
			f.environments = [{
				...environment,
				appId: 'sample',
				env: 'dev',
				provider: 'zerops',
				createdAt: 1,
				domain: 'changed.example.test',
				publicOrigin: 'https://changed.example.test',
				triggerRef: 'release',
				namespaceId: 'new-ns',
			}]
			await until(() => {
				try {
					f.platform.deploy(f.id)
					return true
				} catch {
					return false
				}
			})
			await until(() => f.platform.status(f.id).deployment?.status === 'succeeded')
			const updates = f.calls.filter((call) => call.method === 'apps.environments.put')
			expect(updates).toHaveLength(2)
			expect(updates[1]?.input['environment']).toMatchObject({
				domain: 'changed.example.test',
				publicOrigin: 'https://changed.example.test',
				triggerRef: 'release',
				namespaceId: 'new-ns',
			})
			expect(f.platform.status(f.id).deployment?.appUrl).toBe('https://changed.example.test/')
		} finally {
			if (previous === undefined) delete process.env['FABRIKA_CONTROL_KEY']
			else process.env['FABRIKA_CONTROL_KEY'] = previous
		}
	}, 20_000)

	test.each(['dirty', 'untracked', 'unpushed', 'mismatch', 'compiler_changes_source'])('%s fails before remote writes', async (problem) => {
		const f = setup()
		source(f, problem === 'compiler_changes_source' ? `await Bun.write('new-source.ts', 'changed')` : '')
		if (problem === 'dirty') writeFileSync(join(f.root, 'zerops.yaml'), 'changed')
		if (problem === 'untracked') writeFileSync(join(f.root, 'extra.ts'), 'new')
		if (problem === 'unpushed') {
			writeFileSync(join(f.root, 'extra.ts'), 'new')
			git(f.root, 'add', 'extra.ts')
			git(f.root, 'commit', '-m', 'unpushed')
		}
		if (problem === 'mismatch') git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/example/other')
		await f.connect()
		f.platform.deploy(f.id)
		await until(() => f.platform.status(f.id).deployment?.status === 'failed')
		expect(f.calls.filter((call) => call.method === 'apps.environments.put' || call.method === 'deploy')).toEqual([])
	}, 15_000)

	test('failed PUT never deploys and upstream secret messages are not exposed', async () => {
		const f = setup()
		source(f)
		await f.connect()
		f.refusePut = true
		f.platform.deploy(f.id)
		await until(() => f.platform.status(f.id).deployment?.status === 'failed')
		expect(f.calls.some((call) => call.method === 'deploy')).toBe(false)
		expect(JSON.stringify(f.platform.status(f.id))).not.toContain(TOKEN)
	}, 15_000)

	test('provider and external source changes fail before environment writes', async () => {
		const f = setup()
		source(f)
		await f.connect()
		f.app.repoUrl = 'https://github.com/example/changed'
		f.platform.deploy(f.id)
		await until(() => f.platform.status(f.id).deployment?.status === 'failed')
		expect(f.calls.filter((call) => call.method === 'apps.environments.put' || call.method === 'deploy')).toEqual([])
	}, 15_000)

	test('tracked symlink config is refused before compilation or remote writes', async () => {
		const f = setup()
		source(f)
		rmSync(join(f.root, 'fabrika.config.ts'))
		writeFileSync(join(f.directory, 'outside.ts'), 'throw new Error("must not execute")')
		symlinkSync(join(f.directory, 'outside.ts'), join(f.root, 'fabrika.config.ts'))
		git(f.root, 'add', 'fabrika.config.ts')
		git(f.root, 'commit', '-m', 'symlink config')
		git(f.root, 'push', 'origin', 'HEAD:main')
		await f.connect()
		f.platform.deploy(f.id)
		await until(() => f.platform.status(f.id).deployment?.status === 'failed')
		expect(f.calls.filter((call) => call.method === 'apps.environments.put' || call.method === 'deploy')).toEqual([])
	}, 15_000)

	test('restart resumes an existing run without another PUT/deploy; mismatched terminal SHA fails', async () => {
		const f = setup()
		const sha = source(f)
		await f.connect()
		f.runStatus = 'running'
		f.platform.deploy(f.id)
		await until(() => f.platform.status(f.id).deployment?.status === 'running')
		const another = join(f.directory, 'another-project')
		mkdirSync(join(another, '.fabrika'), { recursive: true })
		writeFileSync(join(another, '.fabrika', 'config.json'), JSON.stringify({ profile: 'app', sessionId: 'another', createdAt: '2026-09-21T10:00:00Z' }))
		f.platform.register('another', another)
		const credential = f.platform.storage.credential(f.id)
		if (!credential) throw new Error('Missing connected credential')
		f.platform.storage.saveCredential('another', credential)
		expect(() => f.platform.deploy('another')).toThrow('already has a local operation')
		f.restart()
		expect(() => f.platform.deploy('another')).toThrow('already has a local operation')
		expect(f.platform.status(f.id).deployment).toMatchObject({ runId: 'run-1', commitSha: sha })
		await until(() => f.runGets >= 2)
		f.runStatus = 'succeeded'
		f.runSha = 'a'.repeat(40)
		f.tick()
		f.tick()
		await until(() => f.platform.status(f.id).deployment?.status === 'failed')
		expect(f.platform.status(f.id).deployment?.message).toContain('SHA')
		expect(f.platform.status(f.id).deployment?.appUrl).toBeNull()
		expect(f.calls.filter((call) => call.method === 'deploy')).toHaveLength(1)
		expect(f.calls.filter((call) => call.method === 'apps.environments.put')).toHaveLength(1)
	}, 15_000)

	test('disconnect refuses preparation and submission, preserving custody until terminal success', async () => {
		const f = setup()
		source(f)
		await f.connect()
		const release = f.pauseSubmission()
		try {
			f.platform.deploy(f.id)
			expect(() => f.platform.disconnect(f.id)).toThrow('still active')
			await until(() => f.calls.some((call) => call.method === 'deploy'))
			expect(f.platform.storage.project(f.id)?.deployment?.commitSha).not.toBeNull()
			expect(() => f.platform.disconnect(f.id)).toThrow('still active')
			expect(f.platform.storage.credential(f.id)).not.toBeNull()
		} finally {
			release()
		}
		await until(() => f.platform.status(f.id).deployment?.status === 'succeeded')
		expect(f.platform.disconnect(f.id).pairing).toEqual({ status: 'cancelled' })
		expect(f.platform.storage.credential(f.id)).toBeNull()
	}, 15_000)

	test('ambiguous submission stays reserved across restart and cannot be discarded or triggered again', async () => {
		const f = setup()
		const sha = source(f)
		await f.connect()
		f.failSubmissionResponse = true
		f.platform.deploy(f.id)
		await until(() => f.platform.storage.project(f.id)?.deployment?.message?.includes('submission outcome is unknown') === true)
		f.restart()
		expect(f.platform.status(f.id).deployment).toMatchObject({ status: 'preparing', commitSha: sha, runId: null })
		expect(() => f.platform.disconnect(f.id)).toThrow('still active')
		expect(() => f.platform.deploy(f.id)).toThrow('already active')
		expect(f.calls.filter((call) => call.method === 'deploy')).toHaveLength(1)
		expect(f.platform.storage.credential(f.id)).not.toBeNull()
	}, 15_000)

	test.each(['http', 'network', 'request_timeout', 'polling_timeout'])(
		'%s preserves an unobserved run and resumes without another trigger',
		async (failure) => {
			const f = setup()
			const sha = source(f)
			await f.connect()
			f.runStatus = 'running'
			f.platform.deploy(f.id)
			await until(() => f.platform.storage.project(f.id)?.deployment?.status === 'running')
			expect(() => f.platform.disconnect(f.id)).toThrow('still active')
			if (failure === 'http') {
				f.failRunRead = true
				f.tick()
			} else if (failure === 'polling_timeout') {
				f.advance(3601)
				f.tick()
			} else {
				f.options.fetch = async () => {
					throw new DOMException(TOKEN, failure === 'network' ? 'NetworkError' : 'TimeoutError')
				}
				f.restart().status(f.id)
			}
			await until(() => f.platform.storage.project(f.id)?.deployment?.message?.includes('observation is unavailable') === true)
			const saved = f.platform.storage.project(f.id)?.deployment
			expect(saved).toMatchObject({ status: 'running', runId: 'run-1', commitSha: sha, appUrl: null })
			expect(JSON.stringify(saved)).not.toContain(TOKEN)
			expect(() => f.platform.deploy(f.id)).toThrow('already active')
			expect(() => f.platform.disconnect(f.id)).toThrow('still active')
			f.failRunRead = false
			delete f.options.fetch
			f.runStatus = 'succeeded'
			if (failure !== 'http') f.restart()
			await until(() => f.platform.status(f.id).deployment?.status === 'succeeded')
			expect(f.calls.filter((call) => call.method === 'deploy')).toHaveLength(1)
			expect(f.calls.filter((call) => call.method === 'apps.environments.put')).toHaveLength(1)
			expect(f.platform.disconnect(f.id).pairing).toEqual({ status: 'cancelled' })
		},
		15_000,
	)

	test('Git SSH transport retains user authentication context without inheriting platform credentials', async () => {
		const f = setup()
		const sha = source(f)
		git(f.root, 'remote', 'set-url', 'origin', 'git@github.com:example/sample')
		const capture = join(f.directory, 'ssh-env')
		const ssh = join(f.directory, 'ssh')
		writeFileSync(ssh, `#!/bin/sh\nenv > '${capture}'\nexec git-upload-pack '${join(f.directory, 'remote.git')}'\n`, { mode: 0o700 })
		const values = {
			GIT_SSH_COMMAND: ssh,
			GIT_SSH_VARIANT: 'ssh',
			SSH_AUTH_SOCK: '/test/agent.sock',
			FABRIKA_CONTROL_KEY: TOKEN,
			FABRIKA_IAM_KEY: 'iam-sentinel',
			FABRIKA_CONTROL_TOKEN: 'control-sentinel',
			ZEROPS_TOKEN: 'zerops-sentinel',
		}
		const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
		try {
			for (const [key, value] of Object.entries(values)) process.env[key] = value
			expect(await verifySource(f.root, f.app, new AbortController().signal)).toBe(sha)
			const received = readFileSync(capture, 'utf8')
			expect(received).toContain(`HOME=${homedir()}`)
			expect(received).toContain('SSH_AUTH_SOCK=/test/agent.sock')
			expect(received).toContain('PATH=')
			for (const [key, value] of Object.entries(values)) {
				if (key.startsWith('FABRIKA_') || key === 'ZEROPS_TOKEN') {
					expect(received).not.toContain(key)
					expect(received).not.toContain(value)
				}
			}
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		}
	}, 15_000)
})
