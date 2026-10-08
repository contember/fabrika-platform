import type { AuthContext, DomainEvent } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import type { Env } from '../env'
import {
	githubAppCredentialSecretLabel,
	GitHubConnectionStore,
	type GitHubSetupAttempt,
	type GitHubSourceConnection,
	type GitHubSourceConnectionPage,
	type GitHubSourceConnectionPageInput,
} from '../github-connection-store'
import {
	manifestCallback,
	manifestHandoff,
	reconcileSourceConnection,
	repairSourceConnection,
	sourceConnectionList,
	sourceConnectionStatus,
	startSourceConnection,
	verifySourceInstallation,
} from '../source-connection'
import type {
	SourceConnectionCredential,
	SourceConnectionPort,
	SourceGitHubAppIdentity,
	SourceInstallationVerification,
	SourceWebhookConfigurationInput,
} from '../source/connections'
import { readGitHubAppCredential } from '../source/credentials'
import { SourceFailure } from '../source/failure'
import type { PreparedVaultSecret } from '../vault'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'

const ORIGIN = 'https://control.example'

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
	available = true
	installation: SourceInstallationVerification = {
		status: 'installed',
		installationId: 456,
		accountLogin: 'acme',
		repositorySelection: 'selected',
	}
	readonly calls: string[] = []
	readonly credentialRefs: string[] = []
	githubOwner = 'acme'
	githubAppId = 123
	githubAppSlug = 'fabrika-source'
	verifyFails = false
	webhookFailure: unknown | undefined
	readonly webhookSecrets: string[] = []
	readonly webhookUrls: string[] = []

	verifyApp(input: SourceConnectionCredential): Promise<SourceGitHubAppIdentity> {
		this.calls.push('verify')
		if (input.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
		if (this.verifyFails) return Promise.reject(new Error('verify failed with private material'))
		this.credentialRefs.push(input.credentialRef)
		return Promise.resolve(identity(this.githubOwner, this.githubAppId, this.githubAppSlug))
	}

	configureWebhook(input: SourceWebhookConfigurationInput): Promise<void> {
		this.calls.push('webhook')
		if (input.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
		if (this.webhookFailure !== undefined) return Promise.reject(this.webhookFailure)
		this.credentialRefs.push(input.credentialRef)
		this.webhookSecrets.push(input.secret)
		this.webhookUrls.push(input.url)
		return Promise.resolve()
	}

	verifyInstallations(): Promise<SourceInstallationVerification> {
		this.calls.push('installation')
		return Promise.resolve(this.installation)
	}
}

/** The vault row and the checkpoint share one transaction; failing it is a failed vault write. */
class FailingCredentialStore extends GitHubConnectionStore {
	override storeSecretAndCheckpoint(...args: Parameters<GitHubConnectionStore['storeSecretAndCheckpoint']>): Promise<GitHubSetupAttempt | null> {
		const secret: PreparedVaultSecret = args[5]
		if (secret.label === githubAppCredentialSecretLabel(args[0])) return Promise.reject(new Error('vault write failed'))
		return super.storeSecretAndCheckpoint(...args)
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

function identity(owner = 'acme', appId = 123, appSlug = 'fabrika-source'): SourceGitHubAppIdentity {
	return {
		id: appId,
		slug: appSlug,
		htmlUrl: `https://github.com/apps/${appSlug}`,
		public: false,
		owner: { login: owner, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
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

	test('consumes callback state once and leaves durable repair when the caller aborts after the key is stored', async () => {
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
		const state = await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`), caller))
		expect(state.state).toBe('repair-required')
		const attempt = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		expect(attempt?.stateHash).toBeNull()
		expect(attempt?.manifestStateSecretRef).toBeNull()
		expect(attempt?.appCredentialRef).toStartWith('vault:')
		expect(source.calls).toEqual(['verify'])
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
		expect(attempt?.appCredentialRef).toBeNull()
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
		expect(await env.REPOSITORIES.githubConnections.getWorkflowAttempt()).toBeNull()
		expect(await env.REPOSITORIES.githubConnections.getConnection()).toBeNull()
		expect((await queryRowsFromEnv(env, 'SELECT * FROM vault')).length).toBe(0)
	})

	test('fails terminally when the App key cannot be stored but redirects to durable repair once it is', async () => {
		const harness = environment()
		const beforeEnv: Env = {
			...harness,
			REPOSITORIES: { ...harness.REPOSITORIES, githubConnections: new FailingCredentialStore(harness.DB, () => 1_000) },
		}
		const before = new FakeSourceConnection()
		const beforeStarted = await startSourceConnection(
			deps(beforeEnv, before, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await expect(manifestCallback({
			...deps(beforeEnv, before, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})).rejects.toMatchObject({ httpStatus: 503 })
		const failed = await beforeEnv.REPOSITORIES.githubConnections.getAttempt(beforeStarted.connectionId)
		expect(failed).toMatchObject({ status: 'failed', lastErrorCode: 'credential_persistence', appCredentialRef: null })
		expect(await queryRowsFromEnv(beforeEnv, `SELECT label FROM vault WHERE label LIKE '%:app-credential'`)).toEqual([])
		expect(before.calls).toEqual([])

		const afterEnv = environment()
		const after = new FakeSourceConnection()
		after.verifyFails = true
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
		if (repair === null || repair.appCredentialRef === null) throw new Error('repair fixture is incomplete')
		expect(await readGitHubAppCredential(await vaultOf(afterEnv), repair.appCredentialRef, repair.id)).toEqual({
			appId: '123',
			privateKeyPem: 'private-pem',
		})
	})

	test('writes the App key into the vault under its purpose before the callback reports success, and keeps it', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const callback = await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		expect(callback.status).toBe(303)
		const attempt = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		if (attempt === null || attempt.appCredentialRef === null) throw new Error('credential checkpoint missing')
		// Every remote step authenticated with the stored key, never with the value the callback held.
		expect(source.credentialRefs).toEqual([attempt.appCredentialRef, attempt.appCredentialRef])
		const vault = await vaultOf(env)
		expect(await readGitHubAppCredential(vault, attempt.appCredentialRef, attempt.id)).toEqual({ appId: '123', privateKeyPem: 'private-pem' })
		await expect(vault.getSecretForPurpose(attempt.appCredentialRef, { scope: 'platform', label: `platform:github-source:${attempt.id}:webhook` }))
			.rejects.toThrow('purpose mismatch')
		await expect(readGitHubAppCredential(vault, attempt.appCredentialRef, 'other-connection')).rejects.toThrow()
		expect(JSON.stringify(await queryRowsFromEnv(env, 'SELECT * FROM vault'))).not.toContain('private-pem')

		await verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)
		const connection = await env.REPOSITORIES.githubConnections.getConnectionById(started.connectionId)
		expect(connection?.appCredentialRef).toBe(attempt.appCredentialRef)
		expect(await readGitHubAppCredential(vault, attempt.appCredentialRef, attempt.id)).toEqual({ appId: '123', privateKeyPem: 'private-pem' })
	})

	test('reports unavailable and refuses to start without connection support or a vault', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.available = false
		expect(await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({ state: 'unavailable' })
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 503 })

		const { FABRIKA_CONTROL_VAULT_KEY: _vaultKey, ...withoutVault } = environment()
		const available = new FakeSourceConnection()
		expect(await sourceConnectionStatus(deps(withoutVault, available, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({ state: 'unavailable' })
		await expect(startSourceConnection(
			deps(withoutVault, available, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 503 })
		expect(await sourceConnectionStatus(deps(environment(), available, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({ state: 'anonymous' })
		expect(available.calls).toEqual([])
	})

	test('reports connected from the vault-held key without calling GitHub, and unavailable once it cannot be read', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await connectKeyed(env, source)
		source.calls.splice(0)
		const connected = await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))
		expect(connected).toMatchObject({ state: 'connected', connectionId })
		expect(source.calls).toEqual([])
		await env.DB.prepare(`UPDATE vault SET label = 'platform:github-source:other:app-credential' WHERE label LIKE '%:app-credential'`).run()
		expect(await sourceConnectionStatus(deps(env, source, new Request(`${ORIGIN}/api/rpc`)))).toMatchObject({ state: 'unavailable' })
	})

	test('refuses an installation owned by another account', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		source.installation = { status: 'installed', installationId: 456, accountLogin: 'other', repositorySelection: 'all' }
		await expect(verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)).rejects.toMatchObject({
			httpStatus: 409,
		})
		source.installation = { status: 'missing' }
		await expect(verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)).rejects.toMatchObject({
			httpStatus: 409,
		})
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(started.connectionId)).toBeNull()
	})

	test('adds a second private organization and pages stable rows separately from workflow', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const firstId = await connectKeyed(env, source)
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
		const pendingPage = await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), { limit: 10 })
		expect(pendingPage.items.map((item) => item.connectionId)).toEqual([firstId])
		expect(pendingPage.workflow).toMatchObject({ state: 'installation-required', connectionId: started.connectionId })

		const attemptBeforePublish = await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId)
		expect(attemptBeforePublish?.appCredentialRef).toStartWith('vault:')
		expect(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:app-credential' ORDER BY label`)).toEqual(
			[firstId, started.connectionId].sort().map((id) => ({ label: `platform:github-source:${id}:app-credential` })),
		)
		expect(JSON.stringify(pendingPage)).not.toContain('vault:')
		expect(JSON.stringify(await queryRowsFromEnv(env, 'SELECT * FROM github_source_connections_keyed'))).not.toContain('private-pem')
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
		expect([...first.items, ...second.items].map((item) => item.connectionId).sort()).toEqual([firstId, started.connectionId].sort())
		expect(first.workflow).toBeNull()
		expect(second.workflow).toBeNull()
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(started.connectionId)).toMatchObject({
			appCredentialRef: attemptBeforePublish.appCredentialRef,
			webhookUrl: `${ORIGIN}/webhooks/github/${started.connectionId}`,
		})
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'BETA', appName: 'duplicate', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 409 })
	})

	test('repairs an interrupted second setup without changing the first connected row', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const firstId = await connectKeyed(env, source)
		const firstBefore = await env.REPOSITORIES.githubConnections.getConnectionById(firstId)
		source.githubOwner = 'beta'
		source.githubAppId = 234
		source.githubAppSlug = 'fabrika-beta'
		source.verifyFails = true
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
		expect(interrupted.items.map((item) => item.connectionId)).toEqual([firstId])
		expect(interrupted.workflow).toMatchObject({ state: 'repair-required', connectionId: started.connectionId })

		source.verifyFails = false
		const repaired = await repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)
		expect(repaired).toMatchObject({ state: 'installation-required', connectionId: started.connectionId })
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(firstId)).toEqual(firstBefore)
		expect((await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))?.appCredentialRef).toStartWith('vault:')
	})

	test('reports why a repair stopped instead of answering 200 with the same red lamp', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await connectKeyed(env, source)
		source.githubOwner = 'beta'
		source.githubAppId = 234
		source.githubAppSlug = 'fabrika-beta'
		source.verifyFails = true
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

	test('reconciles a stable keyed webhook from its purpose-bound vault secret without changing connection state', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await connectKeyed(env, source)
		const before = await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)
		const setupSecret = source.webhookSecrets.at(-1)
		if (before === null || setupSecret === undefined) throw new Error('keyed connection fixture is incomplete')
		source.calls.splice(0)
		source.webhookSecrets.splice(0)
		source.webhookUrls.splice(0)
		source.credentialRefs.splice(0)
		const caller = auth()

		const reconciled = await reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc'), caller), connectionId)

		expect(reconciled).toMatchObject({ state: 'connected', connectionId })
		expect(source.calls).toEqual(['verify', 'webhook'])
		expect(source.webhookSecrets).toEqual([setupSecret])
		expect(source.webhookUrls).toEqual([`${ORIGIN}/webhooks/github/${connectionId}`])
		expect(source.credentialRefs).toEqual([before.appCredentialRef, before.appCredentialRef])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toEqual(before)
		expect(caller.events.at(-1)).toEqual({
			action: 'source.connection.reconcile',
			resourceType: 'source_connection',
			resourceId: connectionId,
		})
	})

	test('refuses to recover a stable connection from a different GitHub App', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await connectKeyed(env, source)
		const before = await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)
		source.githubAppId = 999
		source.calls.splice(0)

		await expect(reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc')), connectionId)).rejects.toMatchObject({
			httpStatus: 409,
			message: 'the vault-held key belongs to a different GitHub App',
		})
		expect(source.calls).toEqual(['verify'])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toEqual(before)
	})

	test('fails a stable reconciliation closed with a bounded source reason', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await connectKeyed(env, source)
		source.webhookFailure = new SourceFailure('credentials_invalid', 'credentials')
		await expect(reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc')), connectionId)).rejects.toMatchObject({
			httpStatus: 503,
			message: 'could not configure the GitHub webhook: credentials_invalid',
		})
		source.webhookFailure = new Error('must not reach the browser')
		await expect(reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc')), connectionId)).rejects.toMatchObject({
			httpStatus: 503,
			message: 'could not configure the GitHub webhook',
		})
		await expect(reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc')), 'missing')).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('requires a same-origin human to reconcile a stable connection', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await connectKeyed(env, source)
		await expect(reconcileSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth('service')),
			connectionId,
		)).rejects.toMatchObject({ httpStatus: 403 })
		await expect(reconcileSourceConnection(
			deps(env, source, new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { origin: 'https://evil.example' } })),
			connectionId,
		)).rejects.toMatchObject({ httpStatus: 403 })
	})

	test('rejects a same-owner publish race atomically without retaining an attempt or manifest secret', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await connectKeyed(env, source)
		const vaultBefore = await queryRowsFromEnv(env, 'SELECT id FROM vault')
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

async function connectKeyed(env: Env, source: FakeSourceConnection): Promise<string> {
	source.githubOwner = 'acme'
	source.githubAppId = 123
	source.githubAppSlug = 'fabrika-source'
	const started = await startSourceConnection(
		deps(env, source, mutationRequest('/api/rpc')),
		{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
	)
	const callback = await manifestCallback({
		...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${token(32)}`)),
		exchangeManifest: () => Promise.resolve(createdApp()),
	})
	if (callback.status !== 303) throw new Error('keyed callback did not redirect')
	const connected = await verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)
	if (connected.state !== 'connected') throw new Error('keyed setup did not connect')
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

function vaultOf(env: Env): Promise<Vault> {
	return Vault.create(env.DB, testKey())
}
