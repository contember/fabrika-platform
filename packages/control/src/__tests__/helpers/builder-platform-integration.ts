import { SESSION_COOKIE } from '@fabrika/auth-core'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpIamRpc } from '../../../../auth/src/rpc-http'
import { startDaemon } from '../../../../builder/daemon/src/index'
import { PlatformStorage } from '../../../../builder/daemon/src/platform-storage'
import { parseBuilderPlatformStatus } from '../../../../builder/shared'
import { createHarness as createIamHarness, seedInlineGrant, seedUser } from '../../../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../../../iam/src/app'
import type { Env as IamEnv } from '../../../../iam/src/env'
import type { ControlProvider, ProviderDeployInput } from '../../../../provider-contract/src/index'
import { Authorizer, compileGates, HttpIamGateway, type ResolvedApp } from '../../../../proxy-core/src/index'
import { CONTROL_PROXY_GATES } from '../../../fabrika.gates'
import { controlApp } from '../../app'
import { runControlJob } from '../../consumer'
import type { Env as ControlEnv } from '../../env'
import type { ControlJobMessage } from '../../run-lifecycle'
import { memoryCommits } from './commits'
import { createHarness as createControlHarness } from './harness'
import { unusedSourceConnection } from './source-connection'

export async function integrationFixture() {
	const directory = mkdtempSync('/tmp/opencode/builder-cross-plane-')
	const root = join(directory, 'project')
	const id = 'cross-plane'
	const iam = createIamHarness()
	const control = createControlHarness()
	const cleanup: (() => void)[] = []
	const pending = new Set<Promise<unknown>>()
	const exec = {
		waitUntil(promise: Promise<unknown>) {
			pending.add(promise)
			void promise.then(() => pending.delete(promise), () => pending.delete(promise))
		},
	}
	const paths: string[] = []
	const jobs: ControlJobMessage[] = []
	const deployments: ProviderDeployInput[] = []
	async function close() {
		for (const stop of cleanup.reverse()) stop()
		await Promise.allSettled([...pending])
		iam.sqlite.close()
		control.sqlite.close()
		rmSync(directory, { recursive: true, force: true })
	}
	try {
		mkdirSync(join(root, '.fabrika'), { recursive: true })
		writeFileSync(join(root, '.fabrika/config.json'), JSON.stringify({ profile: 'app', sessionId: id, createdAt: new Date().toISOString() }))
		const rpcKey = crypto.randomUUID(), proxyKey = crypto.randomUUID()
		const iamApp = createIamApp({ rpcKey, proxyKey })
		const iamServer = Bun.serve({
			port: 0,
			hostname: 'localhost',
			fetch(request) {
				paths.push(new URL(request.url).pathname)
				return iamApp.fetch(request, iamEnv, exec)
			},
		})
		cleanup.push(() => iamServer.stop(true))
		const issuer = `http://localhost:${iamServer.port}`
		const iamEnv: IamEnv = {
			DB: {
				prepare: () => {
					throw new Error('IAM must use its own injected repositories')
				},
				batch: async () => {
					throw new Error('IAM must use its own injected repositories')
				},
			},
			REPOSITORIES: iam.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '["operator@example.test"]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'local',
			ISSUER: issuer,
			FABRIKA_IAM_SIGNING_KEYS: '',
			FABRIKA_IAM_PROVISIONING_KEY: '',
			OIDC_ENABLED: 'false',
			PASSWORD_ENABLED: 'true',
		}
		const humanId = seedUser(iam.sqlite, { email: 'operator@example.test', sub: 'operator' })
		seedInlineGrant(iam.sqlite, humanId, ['app.manage', 'deploy.trigger', 'deploy.read'], { type: 'app', value: 'sample' }, 'vozka')
		seedInlineGrant(iam.sqlite, humanId, ['namespace.manage'], null, 'vozka')
		const session = await iam.signSession(humanId, { email: 'operator@example.test', authenticationMethod: 'password', idpSub: null })
		await control.repositories.registry.createApp({ id: 'sample', repoUrl: 'https://github.com/example/sample', defaultBranch: 'main' })
		await control.repositories.registry.createApp({ id: 'other', repoUrl: 'https://github.com/example/other' })
		await control.repositories.registry.createDeploymentNamespace({
			id: 'integration-dev',
			env: 'dev',
			provider: 'zerops',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'zerops', version: 1, payload: {} }),
			state: 'ready',
		})
		const provider: ControlProvider = {
			id: 'zerops',
			normalizeRegistration: (input) => input,
			resolveSource: async (input) => ({ commitSha: git(join(directory, 'remote.git'), 'rev-parse', `${input.app.source.ref}^{commit}`) }),
			namespaces: {
				normalize: (namespace) => namespace,
				namespaceResourceClaims: () => [],
				registrationResourceClaims: () => ['app'],
				provision: async () => {
					throw new Error('Unexpected provisioning')
				},
				reconcile: async () => {
					throw new Error('Unexpected reconciliation')
				},
			},
			deploy: async (input) => {
				deployments.push(input)
				return { state: 'succeeded' }
			},
		}
		const gateway = new HttpIamGateway({ origin: issuer, key: proxyKey })
		const authorizer = new Authorizer({ issuer, iam: gateway, cache: null })
		const resolved: ResolvedApp = {
			kind: 'gates',
			app: { id: 'vozka', hosts: ['localhost'], upstream: 'control', scheme: 'http', gates: CONTROL_PROXY_GATES },
			gates: compileGates(CONTROL_PROXY_GATES),
		}
		const controlServer = Bun.serve({
			port: 0,
			hostname: 'localhost',
			async fetch(request) {
				const headers = new Headers(request.headers)
				headers.delete('X-Fabrika-Token')
				headers.delete('X-Request-Id')
				const decision = await authorizer.authorize(resolved, {
					method: request.method,
					url: new URL(request.url),
					rawPath: new URL(request.url).pathname,
					headers,
					requestId: crypto.randomUUID(),
				})
				if (decision.outcome !== 'allow') return new Response(null, { status: decision.status })
				if (decision.token) headers.set('X-Fabrika-Token', decision.token)
				return controlApp.fetch(new Request(request, { headers }), {
					env: controlEnv,
					provider,
					sourceConnection: unusedSourceConnection(provider.id),
				}, exec)
			},
		})
		cleanup.push(() => controlServer.stop(true))
		const origin = `http://localhost:${controlServer.port}`
		const controlEnv: ControlEnv = {
			DB: control.d1,
			REPOSITORIES: control.repositories,
			ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
			RUN_LOGS: { get: async () => null, put: async () => {}, delete: async () => {} },
			COMMITS: memoryCommits(),
			DEPLOY_QUEUE: {
				send: async (job) => {
					jobs.push(job)
				},
			},
			WAIT_UNTIL: exec.waitUntil,
			ENVIRONMENT: 'local',
			IAM: new HttpIamRpc({ origin: issuer, key: rpcKey }),
			FABRIKA_IAM_ISSUER: issuer,
			FABRIKA_CONTROL_DOMAIN: origin,
		}
		const options = { stateDir: join(directory, 'state'), credentialDir: join(directory, 'keys'), dataDir: join(directory, 'data') }
		const daemon = startDaemon({ port: 0, sessionsDir: join(directory, 'sessions'), platform: options })
		cleanup.push(() => daemon.stop())
		const localOrigin = `http://localhost:${daemon.port}`
		async function local(action: string, input?: unknown) {
			const response = await fetch(
				`${localOrigin}/api/project/${id}/${action}`,
				input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) },
			)
			if (!response.ok) throw new Error(`Local ${action} failed: ${response.status}`)
			return parseBuilderPlatformStatus(await response.json())
		}
		function rpc(method: string, input: unknown, token?: string) {
			return fetch(`${origin}/api/rpc`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(token ? { authorization: `Bearer ${token}` } : { cookie: `${SESSION_COOKIE}=${session}`, origin }),
				},
				body: JSON.stringify({ method, input }),
			})
		}
		const storage = new PlatformStorage(options.stateDir, options.credentialDir, options.dataDir)
		await local('register', { projectRoot: root })
		return {
			directory,
			root,
			id,
			origin,
			issuer,
			paths,
			jobs,
			deployments,
			iam,
			control,
			local,
			rpc,
			storage,
			close,
			consume: (job: ControlJobMessage) => runControlJob(controlEnv, provider, job),
		}
	} catch (error) {
		await close()
		throw error
	}
}

export function integrationSource(f: { directory: string; root: string }) {
	const remote = join(f.directory, 'remote.git')
	mkdirSync(remote)
	git(remote, 'init', '--bare', '--initial-branch=main')
	git(f.root, 'init', '--initial-branch=main')
	git(f.root, 'config', 'user.email', 'test@example.test')
	git(f.root, 'config', 'user.name', 'Integration Test')
	git(f.root, 'config', `url.${remote}.insteadOf`, 'https://github.com/example/sample')
	git(f.root, 'remote', 'add', 'origin', 'https://github.com/example/sample')
	writeFileSync(join(f.root, '.gitignore'), '.fabrika/\n')
	writeFileSync(
		join(f.root, 'fabrika.config.ts'),
		`import { defineApp } from ${
			JSON.stringify(import.meta.resolve('@fabrika/provider-zerops'))
		}\nexport default defineApp({ id: 'sample', target: { platform: 'zerops', services: () => [{ hostname: 'app', type: 'alpine/bun@1.3' }] } })\n`,
	)
	writeFileSync(join(f.root, 'zerops.yaml'), 'zerops:\n  - setup: app\n    run:\n      base: alpine/bun@1.3\n      start: bun server.ts\n')
	git(f.root, 'add', '.gitignore', 'fabrika.config.ts', 'zerops.yaml')
	git(f.root, 'commit', '-m', 'test source')
	git(f.root, 'push', 'origin', 'HEAD:main')
	return git(f.root, 'rev-parse', 'HEAD')
}

export function git(root: string, ...args: string[]): string {
	const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
	if (result.exitCode !== 0) throw new Error('Integration fixture Git command failed')
	return result.stdout.toString().trim()
}
