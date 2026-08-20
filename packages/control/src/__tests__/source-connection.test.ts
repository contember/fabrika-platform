import type { AuthContext, DomainEvent } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import type { Env } from '../env'
import {
	GitHubConnectionStore,
	type GitHubSetupAttempt,
	type GitHubSourceConnection,
	type GitHubSourceConnectionPage,
	type GitHubSourceConnectionPageInput,
} from '../github-connection-store'
import {
	adoptExistingSourceConnection,
	manifestCallback,
	manifestHandoff,
	repairSourceConnection,
	sourceConnectionList,
	sourceConnectionStatus,
	startSourceConnection,
	verifySourceInstallation,
} from '../source-connection'
import type {
	SourceConnectionPort,
	SourceConnectionRuntimeStatus,
	SourceCredentialActivation,
	SourceCredentialActivationInput,
	SourceCredentialInput,
	SourceInstallationVerification,
	SourceInstallationVerificationInput,
	SourceWebhookConfiguration,
	SourceWebhookConfigurationInput,
} from '../source-connection-port'
import { createHarness } from './helpers/harness'

const ORIGIN = 'https://control.example'
const CREDENTIAL_DIGEST = 'c'.repeat(64)

function testKey(): string {
	let binary = ''
	for (let index = 0; index < 32; index++) binary += String.fromCharCode(index + 1)
	return btoa(binary)
}

function auth(type: 'user' | 'service' = 'user', allowed = true, auditFails = false): AuthContext & { readonly events: DomainEvent[] } {
	const events: DomainEvent[] = []
	return {
		ok: true,
		principal: { id: `${type}-1`, type, label: `${type}@example.test` },
		can: () => allowed,
		scopedTo: () => null,
		audit: (event) => {
			events.push(event)
			return auditFails ? Promise.reject(new Error('audit unavailable with sensitive detail')) : Promise.resolve()
		},
		events,
	}
}

class FakeSourceConnection implements SourceConnectionPort {
	readonly provider = 'zerops'
	inspection: Awaited<ReturnType<SourceConnectionPort['inspect']>> = { state: 'anonymous' }
	installation: SourceInstallationVerification = {
		status: 'installed',
		installationId: 456,
		accountLogin: 'acme',
		repositorySelection: 'selected',
	}
	readonly calls: string[] = []
	readonly transportKinds: string[] = []
	readonly preparedConnectionIds: string[] = []
	readonly credentialDigests = new Map<string, string>()
	githubOwner = 'acme'
	githubAppId = 123
	githubAppSlug = 'fabrika-source'
	prepareFails = false
	activateFails = false
	abortAdoption: (() => void) | undefined

	inspect(): Promise<typeof this.inspection> {
		this.calls.push('inspect')
		return Promise.resolve(this.inspection)
	}

	prepareCredential(input: SourceCredentialInput): Promise<{ bundle: string; sha256: string }> {
		this.calls.push('prepare')
		this.preparedConnectionIds.push(input.connectionId)
		if (this.prepareFails) return Promise.reject(new Error('prepare failed with private material'))
		return Promise.resolve({ bundle: 'bounded-credential-bundle', sha256: CREDENTIAL_DIGEST })
	}

	adoptExisting(): Promise<SourceCredentialActivation> {
		this.calls.push('adopt')
		this.abortAdoption?.()
		return Promise.resolve(this.activation('adopted-connection'))
	}

	activate(input: SourceCredentialActivationInput): Promise<SourceCredentialActivation> {
		this.calls.push('activate')
		this.transportKinds.push(input.transportKind)
		if (input.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
		if (this.activateFails) return Promise.reject(new Error('activate failed with private material'))
		this.credentialDigests.set(input.connectionId, input.credentialSha256)
		return Promise.resolve({ ...this.activation(input.connectionId), credentialSha256: input.credentialSha256 })
	}

	status(input: { connectionId: string; transportKind: 'legacy-v1' | 'keyed-v2' }): Promise<SourceConnectionRuntimeStatus> {
		this.calls.push('status')
		this.transportKinds.push(input.transportKind)
		return Promise.resolve({
			state: 'active',
			credentialSha256: this.credentialDigests.get(input.connectionId) ?? CREDENTIAL_DIGEST,
			githubApp: this.activation(input.connectionId).githubApp,
		})
	}

	configureWebhook(input: SourceWebhookConfigurationInput): Promise<SourceWebhookConfiguration> {
		this.calls.push('webhook')
		this.transportKinds.push(input.transportKind)
		if (input.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
		return Promise.resolve({
			connectionId: input.connectionId,
			credentialSha256: input.credentialSha256,
			webhook: { url: input.url, contentType: 'json', insecureSsl: '0' },
		})
	}

	verifyInstallations(input: SourceInstallationVerificationInput): Promise<SourceInstallationVerification> {
		this.calls.push('installation')
		this.transportKinds.push(input.transportKind)
		return Promise.resolve(this.installation)
	}

	private activation(connectionId: string): SourceCredentialActivation {
		return activation(connectionId, this.githubOwner, this.githubAppId, this.githubAppSlug)
	}
}

class PublishBetweenListReadsStore extends GitHubConnectionStore {
	private readonly workflowRead = Promise.withResolvers<void>()

	constructor(db: Env['DB'], private readonly workflow: GitHubSetupAttempt) {
		super(db)
	}

	override getWorkflowAttempt(): Promise<GitHubSetupAttempt | null> {
		this.workflowRead.resolve()
		return Promise.resolve(this.workflow)
	}

	override async listConnections(_input: GitHubSourceConnectionPageInput = {}): Promise<GitHubSourceConnectionPage> {
		await this.workflowRead.promise
		return { items: [], nextCursor: null }
	}
}

class StaleSourceConnectionPreflightStore extends GitHubConnectionStore {
	override listConnections(_input: GitHubSourceConnectionPageInput = {}): Promise<GitHubSourceConnectionPage> {
		return Promise.resolve({ items: [], nextCursor: null })
	}

	override getWorkflowAttempt(): Promise<GitHubSetupAttempt | null> {
		return Promise.resolve(null)
	}

	override getConnectionByOwner(_owner: string): Promise<GitHubSourceConnection | null> {
		return Promise.resolve(null)
	}
}

function activation(connectionId: string, owner = 'acme', appId = 123, appSlug = 'fabrika-source'): SourceCredentialActivation {
	return {
		connectionId,
		credentialSha256: CREDENTIAL_DIGEST,
		githubApp: {
			id: appId,
			slug: appSlug,
			htmlUrl: `https://github.com/apps/${appSlug}`,
			public: false,
			owner: { login: owner, type: 'Organization' },
			permissions: { contents: 'read' },
			events: ['push'],
		},
	}
}

function environment(now: () => number = () => 1_000): Env {
	const harness = createHarness(now)
	return {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response()) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		REPO_EVENTS: { verifyWebhook: () => Promise.resolve(null), resolveInstallationId: () => Promise.resolve(null) },
		ENVIRONMENT: 'test',
		FABRIKA_CONTROL_DOMAIN: ORIGIN,
		FABRIKA_CONTROL_VAULT_KEY: testKey(),
	}
}

function deps(env: Env, source: SourceConnectionPort, request: Request, caller = auth(), now: () => number = () => 1_000) {
	return { env, source, auth: caller, request, now, randomBytes: (length: number) => new Uint8Array(length).fill(7) }
}

describe('GitHub source connection workflow', () => {
	test('persists encrypted one-use state and emits a secure plain-submit handoff', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{
				organization: 'Acme',
				appName: 'fabrika-source',
				visibility: 'private',
				repositories: [{ owner: 'acme', name: 'App' }],
			},
		)
		expect(started.continuePath).toBe(`/api/source/github/manifest/${started.connectionId}`)
		const attempt = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		expect(attempt?.stateHash).toMatch(/^[0-9a-f]{64}$/)
		expect(attempt?.manifestStateSecretRef).toStartWith('vault:')
		expect(await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({
			state: 'setup-pending',
			continuePath: started.continuePath,
		})
		const stored = await queryRowsFromEnv(env, 'SELECT * FROM vault')
		expect(JSON.stringify(stored)).not.toContain(token(32))

		const response = await manifestHandoff(
			deps(env, source, new Request(`${ORIGIN}${started.continuePath}`)),
			started.connectionId,
		)
		const body = await response.text()
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(response.headers.get('content-security-policy')).toContain('form-action https://github.com')
		expect(body).toContain('method="post"')
		expect(body).toContain('https://github.com/organizations/acme/settings/apps/new')
		expect(body).not.toContain('<script')
	})

	test('uses the configured public origin behind a TLS-terminating proxy', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, new Request('http://control:3000/api/rpc', { method: 'POST', headers: { origin: ORIGIN } })),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const response = await manifestHandoff(
			deps(env, source, new Request(`http://control:3000${started.continuePath}`)),
			started.connectionId,
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain(`${ORIGIN}/api/source/github/callback`)
	})

	test('keeps the manifest handoff resumable when post-commit audit delivery fails', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth('user', true, true)),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)).rejects.toThrow('audit unavailable')
		const status = await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))
		expect(status).toMatchObject({ state: 'setup-pending', continuePath: expect.stringContaining('/api/source/github/manifest/') })
		expect(JSON.stringify(status)).not.toContain(token(32))
		expect((await queryRowsFromEnv(env, 'SELECT * FROM vault')).length).toBe(1)
	})

	test('refuses an expired direct manifest handoff and removes its encrypted capability', async () => {
		let clock = 1_000
		const env = environment(() => clock)
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		clock = 1_600
		await expect(manifestHandoff(
			deps(env, source, new Request(`${ORIGIN}${started.continuePath}`)),
			started.connectionId,
		)).rejects.toMatchObject({ httpStatus: 404 })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)).toMatchObject({
			status: 'failed',
			manifestStateSecretRef: null,
		})
		expect((await queryRowsFromEnv(env, 'SELECT * FROM vault')).length).toBe(0)
	})

	test('renews a near-expiry callback capability when the initiating human opens the handoff', async () => {
		let clock = 1_000
		const env = environment(() => clock)
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth(), () => clock),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		clock = 1_599
		expect(
			(await manifestHandoff(
				deps(env, source, new Request(`${ORIGIN}${started.continuePath}`), auth(), () => clock),
				started.connectionId,
			)).status,
		).toBe(200)
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)).toMatchObject({ expiresAt: 2_199 })
	})

	test('consumes callback state once and leaves durable repair when the caller aborts after recovery', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const caller = auth()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), caller),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const controller = new AbortController()
		const request = new Request(`${ORIGIN}/api/source/github/callback?code=one-time&state=${token(32)}`, { signal: controller.signal })
		await expect(manifestCallback({
			...deps(env, source, request, caller),
			exchangeManifest: () => {
				controller.abort()
				return Promise.resolve({
					id: 123,
					slug: 'fabrika-source',
					htmlUrl: 'https://github.com/apps/fabrika-source',
					pem: 'private-pem',
					webhookSecret: 'unused-manifest-secret',
				})
			},
		})).rejects.toMatchObject({ name: 'AbortError' })
		const state = await env.REPOSITORIES.githubConnections.getState()
		expect(state.state).toBe('repair_required')
		const attempt = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		expect(attempt?.stateHash).toBeNull()
		expect(attempt?.manifestStateSecretRef).toBeNull()
		expect(attempt?.recoverySecretRef).toStartWith('vault:')
		expect(source.calls).toEqual(['inspect', 'prepare', 'activate'])
		expect(
			await manifestCallback({
				...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=two&state=${token(32)}`), caller),
				exchangeManifest: () => Promise.reject(new Error('must not run')),
			}).then(() => 'ok', () => 'rejected'),
		).toBe('rejected')
	})

	test('terminalizes a claimed callback before propagating caller cancellation', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const caller = auth()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), caller),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const controller = new AbortController()
		await expect(manifestCallback({
			...deps(
				env,
				source,
				new Request(`${ORIGIN}/api/source/github/callback?code=one-time&state=${token(32)}`, { signal: controller.signal }),
				caller,
			),
			exchangeManifest: () => {
				controller.abort()
				return Promise.reject(new DOMException('aborted', 'AbortError'))
			},
		})).rejects.toMatchObject({ name: 'AbortError' })
		const attempt = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		expect(attempt?.status).toBe('failed')
		expect(attempt?.phase).toBe('exchange_claimed')
		expect(attempt?.recoverySecretRef).toBeNull()
	})

	test('strictly rejects callback extras and cross-organization repositories before effects', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{
				organization: 'acme',
				appName: 'source',
				visibility: 'private',
				repositories: [{ owner: 'other', name: 'app' }],
			},
		)).rejects.toThrow('repositories must belong')
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'source', visibility: 'public', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 400 })
		expect(source.calls).toEqual([])
		await expect(manifestCallback(deps(
			env,
			source,
			new Request(`${ORIGIN}/api/source/github/callback?code=a&state=b&extra=c`),
		))).rejects.toThrow('source connection request failed')
		await expect(manifestCallback(deps(
			env,
			source,
			new Request(`${ORIGIN}/api/source/github/callback?code=a&code=b&state=c`),
		))).rejects.toThrow('source connection request failed')
	})

	test('rejects manifest-incompatible names before provider, attempt, or vault effects', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'source\nname', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 400 })
		expect(source.calls).toEqual([])
		expect(await env.REPOSITORIES.githubConnections.getState()).toEqual({ state: 'anonymous' })
		expect((await queryRowsFromEnv(env, 'SELECT * FROM vault')).length).toBe(0)
	})

	test('fails terminally before recovery but redirects to durable repair after recovery', async () => {
		const beforeEnv = environment()
		const before = new FakeSourceConnection()
		before.prepareFails = true
		const beforeStarted = await startSourceConnection(
			deps(beforeEnv, before, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await expect(manifestCallback({
			...deps(beforeEnv, before, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})).rejects.toMatchObject({ httpStatus: 503 })
		const failed = await beforeEnv.REPOSITORIES.githubConnections.getAttempt(beforeStarted.connectionId)
		expect(failed?.status).toBe('failed')
		expect(failed?.recoverySecretRef).toBeNull()

		const afterEnv = environment()
		const after = new FakeSourceConnection()
		after.activateFails = true
		const afterStarted = await startSourceConnection(
			deps(afterEnv, after, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const response = await manifestCallback({
			...deps(afterEnv, after, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		expect(response.status).toBe(303)
		const repair = await afterEnv.REPOSITORIES.githubConnections.getAttempt(afterStarted.connectionId)
		expect(repair?.status).toBe('repair_required')
		expect(repair?.recoverySecretRef).toStartWith('vault:')
	})

	test('reports unavailable/adoption-required and adopts without exposing source credentials', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.inspection = { state: 'durable', credentialSha256: CREDENTIAL_DIGEST }
		expect(await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({ state: 'adoption-required' })
		const adopted = await adoptExistingSourceConnection(deps(env, source, mutationRequest('/api/rpc')))
		expect(adopted.state).toBe('installation-required')
		expect(JSON.stringify(adopted)).not.toContain(CREDENTIAL_DIGEST)
		expect(source.calls).toEqual(['inspect', 'adopt', 'webhook', 'status'])
	})

	test('leaves provider-owned adoption resumable when the caller aborts after the durable attempt begins', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const controller = new AbortController()
		source.abortAdoption = () => controller.abort()
		await expect(adoptExistingSourceConnection(deps(
			env,
			source,
			new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { origin: ORIGIN }, signal: controller.signal }),
		))).rejects.toMatchObject({ name: 'AbortError' })
		const attempt = await env.REPOSITORIES.githubConnections.getAttempt('adopted-connection')
		expect(attempt?.status).toBe('repair_required')
		expect(attempt?.setupKind).toBe('adoption')
		expect(source.calls).toEqual(['adopt', 'webhook'])
	})

	test('publishes only an exact installation and verifies connected state remotely', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.inspection = { state: 'durable', credentialSha256: CREDENTIAL_DIGEST }
		const adopted = await adoptExistingSourceConnection(deps(env, source, mutationRequest('/api/rpc')))
		if (adopted.state !== 'installation-required') throw new Error('adoption did not reach installation')
		const connected = await verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), adopted.connectionId)
		expect(connected.state).toBe('connected')
		expect((await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))).state).toBe('connected')
		source.installation = { status: 'missing' }
	})

	test('adds a private keyed organization beside the legacy connection and pages stable rows separately from workflow', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const legacyId = await connectLegacy(env, source)
		source.calls.splice(0)
		source.githubOwner = 'beta'
		source.githubAppId = 234
		source.githubAppSlug = 'fabrika-beta'
		source.installation = {
			status: 'installed',
			installationId: 789,
			accountLogin: 'beta',
			repositorySelection: 'selected',
		}

		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{
				organization: 'Beta',
				appName: 'fabrika-beta',
				visibility: 'private',
				repositories: [{ owner: 'beta', name: 'private-app' }],
			},
		)
		expect(source.calls).toEqual([])
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'gamma', appName: 'fabrika-gamma', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 409 })
		const handoff = await manifestHandoff(deps(env, source, new Request(`${ORIGIN}${started.continuePath}`)), started.connectionId)
		const manifestBody = await handoff.text()
		expect(manifestBody).toContain(`${ORIGIN}/webhooks/github/${started.connectionId}`)
		expect(manifestBody).toContain('&quot;public&quot;:false')

		const callback = await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=beta&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp(234, 'fabrika-beta')),
		})
		expect(callback.status).toBe(303)
		expect(source.preparedConnectionIds).toContain(started.connectionId)
		expect(source.transportKinds).toContain('keyed-v2')
		const pendingPage = await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), { limit: 10 })
		expect(pendingPage.items.map((item) => item.connectionId)).toEqual([legacyId])
		expect(pendingPage.workflow).toMatchObject({ state: 'installation-required', connectionId: started.connectionId })

		const attemptBeforePublish = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		expect(attemptBeforePublish?.recoverySecretRef).toBeNull()
		expect(JSON.stringify(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:recovery'`))).toBe('[]')
		expect(JSON.stringify(pendingPage)).not.toContain(CREDENTIAL_DIGEST)
		expect(JSON.stringify(await queryRowsFromEnv(env, 'SELECT * FROM github_source_connections_keyed'))).not.toContain('bounded-credential-bundle')
		const connected = await verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)
		expect(connected).toMatchObject({ state: 'connected', connectionId: started.connectionId })
		const published = await env.REPOSITORIES.githubConnections.getConnectionById(started.connectionId)
		if (published === null || attemptBeforePublish === null) throw new Error('connection publish fixture is incomplete')
		const interleavedEnv: Env = {
			...env,
			REPOSITORIES: {
				...env.REPOSITORIES,
				githubConnections: new PublishBetweenListReadsStore(env.DB, attemptBeforePublish),
			},
		}
		const interleavedPage = await sourceConnectionList(deps(interleavedEnv, source, new Request(`${ORIGIN}/api/rpc`)), { limit: 10 })
		expect(interleavedPage.items).toEqual([])
		expect(interleavedPage.workflow).toBeNull()
		expect(await sourceConnectionStatus(deps(interleavedEnv, source, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({
			state: 'connected',
			connectionId: started.connectionId,
		})

		const first = await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), { limit: 1 })
		const second = await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {
			cursor: first.nextCursor ?? '',
			limit: 1,
		})
		expect([...first.items, ...second.items].map((item) => item.connectionId).sort()).toEqual([legacyId, started.connectionId].sort())
		expect(first.workflow).toBeNull()
		expect(second.workflow).toBeNull()
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(started.connectionId)).toMatchObject({
			transportKind: 'keyed-v2',
			webhookUrl: `${ORIGIN}/webhooks/github/${started.connectionId}`,
		})
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'BETA', appName: 'duplicate', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 409 })
	})

	test('repairs an interrupted second setup without changing the connected legacy row', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const legacyId = await connectLegacy(env, source)
		source.githubOwner = 'beta'
		source.githubAppId = 234
		source.githubAppSlug = 'fabrika-beta'
		source.activateFails = true
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'beta', appName: 'fabrika-beta', visibility: 'private', repositories: [] },
		)
		expect(
			(await manifestCallback({
				...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=beta&state=${token(32)}`)),
				exchangeManifest: () => Promise.resolve(createdApp(234, 'fabrika-beta')),
			})).status,
		).toBe(303)
		const interrupted = await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {})
		expect(interrupted.items.map((item) => item.connectionId)).toEqual([legacyId])
		expect(interrupted.workflow).toMatchObject({ state: 'repair-required', connectionId: started.connectionId })

		source.activateFails = false
		const repaired = await repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)
		expect(repaired).toMatchObject({ state: 'installation-required', connectionId: started.connectionId })
		expect((await env.REPOSITORIES.githubConnections.getConnectionById(legacyId))?.transportKind).toBe('legacy-v1')
		expect((await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))?.recoverySecretRef).toBeNull()
		expect(JSON.stringify(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:recovery'`))).toBe('[]')
	})

	test('reports why a repair stopped instead of answering 200 with the same red lamp', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await connectLegacy(env, source)
		source.githubOwner = 'beta'
		source.githubAppId = 234
		source.githubAppSlug = 'fabrika-beta'
		source.activateFails = true
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'beta', appName: 'fabrika-beta', visibility: 'private', repositories: [] },
		)
		expect(
			(await manifestCallback({
				...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=beta&state=${token(32)}`)),
				exchangeManifest: () => Promise.resolve(createdApp(234, 'fabrika-beta')),
			})).status,
		).toBe(303)
		// The resume hits the same wall. Answering 200 here reads as success to every caller and leaves
		// the console with a red lamp and no reason, which is how a broken setup looked like a stuck button.
		await expect(repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId))
			.rejects.toMatchObject({ httpStatus: 502, message: expect.stringContaining('could not be resumed') })
		expect((await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))?.status).toBe('repair_required')
	})

	test('rejects a same-owner publish race atomically without retaining an attempt or manifest secret', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await connectLegacy(env, source)
		const vaultBefore = await queryRowsFromEnv(env, 'SELECT id FROM vault')
		source.inspection = { state: 'anonymous' }
		const staleEnv: Env = {
			...env,
			REPOSITORIES: {
				...env.REPOSITORIES,
				githubConnections: new StaleSourceConnectionPreflightStore(env.DB),
			},
		}
		await expect(startSourceConnection(
			deps(staleEnv, source, mutationRequest('/api/rpc')),
			{ organization: 'ACME', appName: 'duplicate', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 409 })
		expect(await queryRowsFromEnv(env, 'SELECT id FROM vault')).toEqual(vaultBefore)
		expect(await queryRowsFromEnv(env, `SELECT id FROM github_source_setup_attempts WHERE status IN ('active','repair_required')`)).toEqual([])
	})

	test('requires a same-origin human for every privileged entrypoint', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await expect(startSourceConnection(
			deps(env, source, new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { origin: 'https://evil.example' } })),
			{ organization: 'acme', appName: 'source', visibility: 'private', repositories: [] },
		)).rejects.toThrow('source connection request failed')
		await expect(sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`), auth('service')))).rejects.toThrow(
			'source connection request failed',
		)
	})
})

function mutationRequest(path: string): Request {
	return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN } })
}

async function connectLegacy(env: Env, source: FakeSourceConnection): Promise<string> {
	source.inspection = { state: 'durable', credentialSha256: CREDENTIAL_DIGEST }
	const adopted = await adoptExistingSourceConnection(deps(env, source, mutationRequest('/api/rpc')))
	if (adopted.state !== 'installation-required') throw new Error('legacy adoption did not reach installation')
	const connected = await verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), adopted.connectionId)
	if (connected.state !== 'connected') throw new Error('legacy adoption did not connect')
	return connected.connectionId
}

function createdApp(id = 123, slug = 'fabrika-source') {
	return {
		id,
		slug,
		htmlUrl: `https://github.com/apps/${slug}`,
		pem: 'private-pem',
		webhookSecret: 'unused-manifest-secret',
	}
}

function token(length: number): string {
	let binary = ''
	for (const byte of new Uint8Array(length).fill(7)) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function queryRowsFromEnv(env: Env, sql: string): Promise<Record<string, unknown>[]> {
	return env.DB.prepare(sql).all<Record<string, unknown>>().then((result) => result.results)
}
