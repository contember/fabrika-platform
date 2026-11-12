import type { AuthContext, DomainEvent } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import type { Env } from '../env'
import { handoffRefusal } from '../github/connections/browser'
import { readGitHubAppCredential } from '../github/connections/credentials'
import {
	handedOffInstallationSetup,
	installationSetup,
	reconcileSourceConnection,
	repairSourceConnection,
	verifySourceInstallation,
} from '../github/connections/installation'
import {
	cancelSourceConnection,
	handedOffCallback,
	handedOffManifest,
	handoffOpening,
	manifestCallback,
	manifestHandoff,
	mintSourceConnectionHandoff,
	startSourceConnection,
} from '../github/connections/manifest'
import {
	type GitHubSetupAttempt,
	type GitHubSourceConnection,
	type GitHubSourceConnectionPage,
	type GitHubSourceConnectionPageInput,
} from '../github/connections/model'
import type {
	SourceConnectionCredential,
	SourceConnectionPort,
	SourceGitHubAppIdentity,
	SourceInstallationScope,
	SourceInstallationVerification,
	SourceInstallationVerificationInput,
	SourceWebhookConfigurationInput,
} from '../github/connections/port'
import { githubAppCredentialSecretLabel } from '../github/connections/secrets'
import { sourceConnectionList } from '../github/connections/status'
import { GitHubConnectionStore } from '../github/connections/store'
import { SourceFailure, SourceRateLimited } from '../github/source/failure'
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
	installation: SourceInstallationVerification = {
		status: 'installed',
		installationId: 456,
		accountLogin: 'acme',
		repositorySelection: 'selected',
	}
	readonly calls: string[] = []
	readonly credentialRefs: string[] = []
	githubOwner = 'acme'
	githubOwnerType: 'Organization' | 'User' = 'Organization'
	readonly installationScopes: SourceInstallationScope[] = []
	githubAppId = 123
	githubAppSlug = 'fabrika-source'
	verifyFails = false
	verifyFailure: unknown | undefined
	webhookFailure: unknown | undefined
	readonly webhookSecrets: string[] = []
	readonly webhookUrls: string[] = []

	verifyApp(input: SourceConnectionCredential): Promise<SourceGitHubAppIdentity> {
		this.calls.push('verify')
		if (input.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
		if (this.verifyFails) return Promise.reject(new Error('verify failed with private material'))
		if (this.verifyFailure !== undefined) return Promise.reject(this.verifyFailure)
		this.credentialRefs.push(input.credentialRef)
		return Promise.resolve(identity(this.githubOwner, this.githubAppId, this.githubAppSlug, this.githubOwnerType))
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

	verifyInstallations(input: SourceInstallationVerificationInput): Promise<SourceInstallationVerification> {
		this.calls.push('installation')
		this.installationScopes.push(input.scope)
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

/** A store whose cleanup never runs, so a handler's own expiry check is what refuses. */
class NoReapStore extends GitHubConnectionStore {
	override reapExpiredAttempt(): Promise<GitHubSetupAttempt | null> {
		return Promise.resolve(null)
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

function identity(
	owner = 'acme',
	appId = 123,
	appSlug = 'fabrika-source',
	ownerType: 'Organization' | 'User' = 'Organization',
): SourceGitHubAppIdentity {
	return {
		id: appId,
		slug: appSlug,
		htmlUrl: `https://github.com/apps/${appSlug}`,
		public: false,
		owner: { login: owner, type: ownerType },
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
		ENVIRONMENT: 'test',
		FABRIKA_CONTROL_DOMAIN: ORIGIN,
		FABRIKA_CONTROL_VAULT_KEY: testKey(),
	}
}

function deps(env: Env, source: SourceConnectionPort, request: Request, caller = auth(), now: () => number = () => 1_000) {
	return { env, source, auth: caller, request, now, randomBytes: (length: number) => new Uint8Array(length).fill(7) }
}

describe('GitHub source connection workflow', () => {
	test('persists encrypted one-use state and emits a secure handoff that submits itself under a nonce', async () => {
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
		expect((await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {})).workflow).toMatchObject({
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
		const csp = response.headers.get('content-security-policy') ?? ''
		expect(csp).toContain('form-action https://github.com')
		expect(csp).not.toContain('unsafe-inline')
		expect(body).toContain('method="post"')
		expect(body).toContain('https://github.com/organizations/acme/settings/apps/new')
		const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1]
		expect(nonce).toBeDefined()
		expect(csp).toContain(`style-src 'nonce-${nonce}'`)
		expect(body).toContain(`<script nonce="${nonce}">`)
		expect(body).toContain(`<style nonce="${nonce}">`)
		expect(body.match(/<script/g)?.length).toBe(1)
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
		const body = await response.text()
		expect(body).toContain(`${ORIGIN}/api/source/github/callback`)
		expect(body).toContain(`${ORIGIN}/api/source/github/setup/${started.connectionId}`)
	})

	test('keeps the manifest handoff resumable when post-commit audit delivery fails', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth('user', true, true)),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)).rejects.toThrow('audit unavailable')
		const status = (await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {})).workflow
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
		const state = (await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`), caller), {})).workflow
		expect(state?.state).toBe('repair-required')
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
		expect((await env.REPOSITORIES.githubConnections.listConnections({ limit: 1 })).items).toEqual([])
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
		expect(response.headers.get('location')).toBe('/settings/source')
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
		expect(callback.headers.get('location')).toBe('https://github.com/apps/fabrika-source/installations/new')
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

	test('fails an App GitHub made on a personal account, drops its key, and says what to fix', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.githubOwner = 'someone'
		source.githubOwnerType = 'User'
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await expect(manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})).rejects.toMatchObject({ httpStatus: 422, message: expect.stringContaining('personal account, not in the organization acme') })
		// Parked for a repair it would be stuck: no repair can move an App to an organization, and it held the one slot.
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))
			.toMatchObject({ status: 'failed', lastErrorCode: 'app_owner_not_organization' })
		expect(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:app-credential'`)).toEqual([])
		expect((await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {})).workflow).toMatchObject({ state: 'anonymous' })
	})

	test("connects a personal account's App: GitHub's own creation page, the user installation, and its owner type throughout", async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.githubOwner = 'octocat'
		source.githubOwnerType = 'User'
		source.installation = { status: 'installed', installationId: 789, accountLogin: 'Octocat', repositorySelection: 'all' }
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'Octocat', ownerType: 'User', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const body = await (await manifestHandoff(deps(env, source, new Request(`${ORIGIN}${started.continuePath}`)), started.connectionId)).text()
		expect(body).toContain('action="https://github.com/settings/apps/new?state=')
		expect(body).not.toContain('/organizations/')
		expect(body).toContain('sign in to GitHub as octocat first')
		// Nothing posts the manifest before the person has read which account GitHub will use.
		expect(body).not.toContain('<script')
		expect(body).toContain('Continue to GitHub as octocat')
		const callback = await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		expect(callback.status).toBe(303)
		expect((await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {})).workflow)
			.toMatchObject({ state: 'installation-required', app: { owner: { login: 'octocat', type: 'User' } } })

		const connected = await verifySourceInstallation(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)
		expect(source.installationScopes).toEqual([{ kind: 'account', owner: 'octocat', ownerType: 'User' }])
		expect(connected).toMatchObject({ state: 'connected', app: { owner: { login: 'octocat', type: 'User' } }, installation: { id: 789 } })
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(started.connectionId)).toMatchObject({ appOwnerType: 'User' })
		expect(await reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId)).toMatchObject({ state: 'connected' })

		// The stored owner type is part of the identity a reconcile checks.
		source.githubOwnerType = 'Organization'
		await expect(reconcileSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId))
			.rejects.toMatchObject({ httpStatus: 409 })
	})

	test("fails a personal account's setup when GitHub made the App on another account, and says to sign in as the owner", async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.githubOwner = 'someone-else'
		source.githubOwnerType = 'User'
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'octocat', ownerType: 'User', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await expect(manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})).rejects.toMatchObject({ httpStatus: 422, message: expect.stringContaining('sign in to GitHub as octocat') })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))
			.toMatchObject({ status: 'failed', lastErrorCode: 'app_owner_mismatch' })
		expect(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:app-credential'`)).toEqual([])
	})

	test('scopes an organization setup without repositories to the organization installation', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await connectKeyed(env, source)
		expect(source.installationScopes).toEqual([{ kind: 'account', owner: 'acme', ownerType: 'Organization' }])
		expect(await env.REPOSITORIES.githubConnections.getConnectionByOwner('acme')).toMatchObject({ appOwnerType: 'Organization' })
	})

	test('parks a setup that GitHub rate-limited under its own reason, and a repair resumes it', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.verifyFailure = new SourceRateLimited('credentials', true, new Date(Date.UTC(2026, 9, 27, 12)))
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const callback = await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		expect(callback.headers.get('location')).toBe('/settings/source')
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))
			.toMatchObject({ status: 'repair_required', lastErrorCode: 'rate_limited' })
		expect((await sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`)), {})).workflow)
			.toMatchObject({ state: 'repair-required', reason: 'rate-limited' })

		// Still limited: the repair says so and parks it again under the same reason.
		await expect(repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId))
			.rejects.toMatchObject({ httpStatus: 502, message: expect.stringContaining('rate_limited') })
		expect((await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))?.lastErrorCode).toBe('rate_limited')

		source.verifyFailure = undefined
		expect(await repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId))
			.toMatchObject({ state: 'installation-required', connectionId: started.connectionId })
	})

	test('fails a repair that finds the App on a personal account, and drops its key', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.verifyFails = true
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		source.verifyFails = false
		source.githubOwner = 'someone'
		source.githubOwnerType = 'User'
		await expect(repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId))
			.rejects.toMatchObject({ httpStatus: 422, message: expect.stringContaining('personal account, not in the organization acme') })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))
			.toMatchObject({ status: 'failed', lastErrorCode: 'app_owner_not_organization' })
		expect(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:app-credential'`)).toEqual([])
	})

	test("fails a personal account's repair that finds the App on another account, and says to sign in as the owner", async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		source.verifyFails = true
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'octocat', ownerType: 'User', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=one&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		source.verifyFails = false
		source.githubOwner = 'someone-else'
		source.githubOwnerType = 'User'
		await expect(repairSourceConnection(deps(env, source, mutationRequest('/api/rpc')), started.connectionId))
			.rejects.toMatchObject({ httpStatus: 422, message: expect.stringContaining('sign in to GitHub as octocat') })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(started.connectionId))
			.toMatchObject({ status: 'failed', lastErrorCode: 'app_owner_mismatch' })
		expect(await queryRowsFromEnv(env, `SELECT label FROM vault WHERE label LIKE '%:app-credential'`)).toEqual([])
	})

	test('reports unavailable and refuses to start without a vault', async () => {
		const { FABRIKA_CONTROL_VAULT_KEY: _vaultKey, ...withoutVault } = environment()
		const available = new FakeSourceConnection()
		expect((await sourceConnectionList(deps(withoutVault, available, new Request(`${ORIGIN}/api/rpc`)), {})).workflow).toMatchObject({
			state: 'unavailable',
		})
		await expect(startSourceConnection(
			deps(withoutVault, available, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)).rejects.toMatchObject({ httpStatus: 503 })
		expect((await sourceConnectionList(deps(environment(), available, new Request(`${ORIGIN}/api/rpc`)), {})).workflow).toMatchObject({
			state: 'anonymous',
		})
		expect(available.calls).toEqual([])
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

	test('requires a human to reconcile a stable connection', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await connectKeyed(env, source)
		await expect(reconcileSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth('service')),
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

	test('reads no origin: the proxy admitted the request, and the callback origin is the configured one', async () => {
		// Admission is the proxy's (ADR-0022); `console-admission.test.ts` drives these mutations through it.
		const start = (env: Env) =>
			startSourceConnection(
				deps(env, new FakeSourceConnection(), new Request(`${ORIGIN}/api/rpc`, { method: 'POST' })),
				{ organization: 'acme', appName: 'source', visibility: 'private', repositories: [] },
			)
		await expect(start(environment())).resolves.toMatchObject({ continuePath: expect.stringContaining('/api/source/github/manifest/') })
		const { FABRIKA_CONTROL_DOMAIN: _unset, ...unconfigured } = environment()
		await expect(start(unconfigured)).rejects.toMatchObject({ httpStatus: 403 })
	})

	test('requires a human for every privileged entrypoint', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await expect(startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth('service')),
			{ organization: 'acme', appName: 'source', visibility: 'private', repositories: [] },
		)).rejects.toThrow('source connection request failed')
		await expect(sourceConnectionList(deps(env, source, new Request(`${ORIGIN}/api/rpc`), auth('service')), {})).rejects.toThrow(
			'source connection request failed',
		)
	})
})

describe("GitHub's return to the App's setup URL", () => {
	async function awaitingInstallation(env: Env, source: FakeSourceConnection): Promise<string> {
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		source.calls.splice(0)
		return started.connectionId
	}

	const setup = (env: Env, source: SourceConnectionPort, connectionId: string, query: string, caller = auth()) =>
		installationSetup(deps(env, source, new Request(`${ORIGIN}/api/source/github/setup/${connectionId}${query}`), caller), connectionId)

	test('verifies the installation with the App key and lands on the console connected', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await awaitingInstallation(env, source)
		const response = await setup(env, source, connectionId, '?installation_id=456&setup_action=install')
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/settings/source?github-setup=connected')
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(source.calls).toEqual(['installation'])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toMatchObject({ installationId: 456 })

		const again = await setup(env, source, connectionId, '?installation_id=456&setup_action=update')
		expect(again.headers.get('location')).toBe('/settings/source?github-setup=connected')
		expect(source.calls).toEqual(['installation'])
	})

	test('publishes nothing when the query names an installation the App key does not find', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await awaitingInstallation(env, source)
		const response = await setup(env, source, connectionId, '?installation_id=999&setup_action=install')
		expect(response.headers.get('location')).toBe('/settings/source?github-setup=unverified')
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toBeNull()
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ phase: 'installation_required' })
	})

	test('publishes nothing when GitHub has no installation of the App for the organization', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await awaitingInstallation(env, source)
		source.installation = { status: 'missing' }
		expect((await setup(env, source, connectionId, '?installation_id=456&setup_action=install')).headers.get('location')).toBe(
			'/settings/source?github-setup=unverified',
		)
		source.installation = { status: 'installed', installationId: 456, accountLogin: 'other', repositorySelection: 'all' }
		expect((await setup(env, source, connectionId, '?installation_id=456&setup_action=install')).headers.get('location')).toBe(
			'/settings/source?github-setup=unverified',
		)
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toBeNull()
	})

	test('reports an installation waiting for an owner without asking GitHub', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await awaitingInstallation(env, source)
		const response = await setup(env, source, connectionId, '?setup_action=request')
		expect(response.headers.get('location')).toBe('/settings/source?github-setup=approval-requested')
		expect(source.calls).toEqual([])
	})

	test.each([
		['no query', ''],
		['no setup action', '?installation_id=456'],
		['no installation id', '?setup_action=install'],
		['an unknown setup action', '?installation_id=456&setup_action=delete'],
		['a non-numeric installation id', '?installation_id=45x&setup_action=install'],
		['a repeated installation id', '?installation_id=456&installation_id=457&setup_action=install'],
		['an unsafe installation id', '?installation_id=99999999999999999&setup_action=install'],
	])('refuses %s before any effect', async (_name, query) => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await awaitingInstallation(env, source)
		await expect(setup(env, source, connectionId, query)).rejects.toMatchObject({ httpStatus: 400 })
		expect(source.calls).toEqual([])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toBeNull()
	})

	test('refuses a connection id with no setup behind it', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		await awaitingInstallation(env, source)
		await expect(setup(env, source, 'another-connection', '?installation_id=456&setup_action=install')).rejects.toMatchObject({ httpStatus: 404 })
		expect(source.calls).toEqual([])
	})

	test('leaves a setup that is not waiting for its installation to the console', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const started = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc')),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const response = await setup(env, source, started.connectionId, '?installation_id=456&setup_action=install')
		expect(response.headers.get('location')).toBe('/settings/source')
		expect(source.calls).toEqual([])
	})

	test('requires a person who manages source connections', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await awaitingInstallation(env, source)
		await expect(setup(env, source, connectionId, '?installation_id=456&setup_action=install', auth('service'))).rejects.toMatchObject({
			httpStatus: 403,
		})
		await expect(setup(env, source, connectionId, '?installation_id=456&setup_action=install', auth('user', false))).rejects.toMatchObject({
			httpStatus: 403,
		})
		expect(source.calls).toEqual([])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toBeNull()
	})
})

describe('a handoff link for an organization owner', () => {
	const HANDOFF_TTL = 60 * 60

	async function started(env: Env, source: FakeSourceConnection, now: () => number = () => 1_000): Promise<string> {
		const result = await startSourceConnection(
			deps(env, source, mutationRequest('/api/rpc'), auth(), now),
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		return result.connectionId
	}

	/**
	 * Mint with bytes that differ per draw: the token is `tokenOf(32, fill)` and the rotated manifest state
	 * `tokenOf(32, fill + 1)`, so neither passes for the other, nor for the state the setup started with (fill 7).
	 */
	async function mint(
		env: Env,
		source: FakeSourceConnection,
		connectionId: string,
		fill = 9,
		caller = auth(),
		now: () => number = () => 1_000,
		expiresInSeconds?: number,
	) {
		return await mintSourceConnectionHandoff(
			{ ...deps(env, source, mutationRequest('/api/rpc'), caller, now), randomBytes: drawsFrom(fill) },
			expiresInSeconds === undefined ? { connectionId } : { connectionId, expiresInSeconds },
		)
	}

	const consoleCallback = (env: Env, source: SourceConnectionPort, state = token(32)) =>
		manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${state}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})

	/** What the opening page's script does: post the fragment's token back to the link's path. */
	const post = (
		env: Env,
		source: SourceConnectionPort,
		connectionId: string,
		body: string,
		now: () => number = () => 1_000,
		contentType = 'application/x-www-form-urlencoded',
		query = '',
	) =>
		handedOffManifest({
			env,
			source,
			request: new Request(`${ORIGIN}/api/source/github/handoff/${connectionId}${query}`, {
				method: 'POST',
				headers: { 'content-type': contentType },
				body,
			}),
			now,
		}, connectionId)

	const open = (env: Env, source: SourceConnectionPort, url: string, connectionId: string, now: () => number = () => 1_000) =>
		post(env, source, connectionId, `token=${encodeURIComponent(new URL(url).hash.slice(1))}`, now)

	/** The state a link minted with the default fill carries: minting replaces the manifest state. */
	const ownerCallback = (env: Env, source: SourceConnectionPort, state = tokenOf(32, 10)) =>
		handedOffCallback({
			env,
			source,
			request: new Request(`${ORIGIN}/api/source/github/handoff-callback?code=created&state=${state}`),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})

	const ownerSetup = (env: Env, source: SourceConnectionPort, connectionId: string, query: string) =>
		handedOffInstallationSetup(
			{ env, source, request: new Request(`${ORIGIN}/api/source/github/handoff-setup/${connectionId}${query}`) },
			connectionId,
		)

	test('lets an owner without a console session create and install the App, and spends the link', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		const caller = auth()
		const handoff = await mint(env, source, connectionId, 9, caller)
		expect(handoff).toEqual({
			connectionId,
			url: `${ORIGIN}/api/source/github/handoff/${connectionId}#${tokenOf(32, 9)}`,
			expiresAt: 1_000 + HANDOFF_TTL,
		})
		expect(caller.events).toEqual([{ action: 'source.connection.handoff', resourceType: 'source_connection', resourceId: connectionId }])
		expect(JSON.stringify(await queryRowsFromEnv(env, 'SELECT * FROM github_source_setup_attempts'))).not.toContain(tokenOf(32, 9))

		// The link's path opens a page that holds no secret and reads nothing stored.
		const opening = handoffOpening({ env, source, request: new Request(handoff.url) }, connectionId)
		expect(opening.headers.get('content-security-policy')).toContain("form-action 'self'")
		const openingBody = await opening.text()
		expect(openingBody).toContain('location.hash')
		expect(openingBody).not.toContain(tokenOf(32, 9))
		// A mail tool's tracking parameters do not break the link.
		expect(
			handoffOpening({ env, source, request: new Request(`${ORIGIN}/api/source/github/handoff/${connectionId}?utm_source=mail`) }, connectionId).status,
		)
			.toBe(200)

		const page = await open(env, source, handoff.url, connectionId)
		expect(page.status).toBe(200)
		expect(page.headers.get('cache-control')).toBe('no-store')
		const body = await page.text()
		expect(body).toContain(`${ORIGIN}/api/source/github/handoff-callback`)
		expect(body).toContain(`${ORIGIN}/api/source/github/handoff-setup/${connectionId}`)
		expect(body).not.toContain(`${ORIGIN}/api/source/github/callback`)
		expect(body).toContain('your administrator sees the connection')

		const callback = await ownerCallback(env, source)
		expect(callback.status).toBe(303)
		expect(callback.headers.get('location')).toBe('https://github.com/apps/fabrika-source/installations/new')
		expect(await open(env, source, handoff.url, connectionId).catch((error: unknown) => error)).toMatchObject({ httpStatus: 404 })

		source.calls.splice(0)
		const installed = await ownerSetup(env, source, connectionId, '?installation_id=456&setup_action=install')
		expect(installed.status).toBe(200)
		expect(installed.headers.get('content-security-policy')).not.toContain('unsafe-inline')
		expect(await installed.text()).toContain('GitHub is connected')
		expect(source.calls).toEqual(['installation'])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toMatchObject({ installationId: 456 })
		expect(await (await ownerSetup(env, source, connectionId, '?installation_id=456&setup_action=update')).text()).toContain('GitHub is connected')
	})

	test('refuses a wrong, replaced or expired token and a link with anything else in its query', async () => {
		let clock = 1_000
		const now = () => clock
		const env = environment(now)
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source, now)
		const first = await mint(env, source, connectionId, 9, auth(), now)
		const second = await mint(env, source, connectionId, 11, auth(), now)
		await expect(open(env, source, first.url, connectionId, now)).rejects.toMatchObject({ httpStatus: 404 })
		await expect(post(env, source, connectionId, `token=${token(32)}`, now)).rejects.toMatchObject({ httpStatus: 404 })
		// The manifest state is visible in the manifest page and in GitHub's URL; it never passes for the token.
		await expect(post(env, source, connectionId, `token=${tokenOf(32, 12)}`, now)).rejects.toMatchObject({ httpStatus: 404 })
		expect((await env.REPOSITORIES.githubConnections.getAttempt(connectionId))?.stateHash).toBe(await sha256Hex(tokenOf(32, 12)))
		const secondToken = new URL(second.url).hash.slice(1)
		for (
			const [body, contentType, query] of [
				[`token=${secondToken}&state=${token(32)}`, 'application/x-www-form-urlencoded', ''],
				[`token=${secondToken}&token=${secondToken}`, 'application/x-www-form-urlencoded', ''],
				['', 'application/x-www-form-urlencoded', ''],
				[JSON.stringify({ token: secondToken }), 'application/json', ''],
				[`token=${secondToken}`, 'application/x-www-form-urlencoded', `?token=${secondToken}`],
			] as const
		) {
			await expect(post(env, source, connectionId, body, now, contentType, query)).rejects.toMatchObject({ httpStatus: 400 })
		}
		expect((await open(env, source, second.url, connectionId, now)).status).toBe(200)

		// A newer link replaced the manifest state too: a page opened with the first link cannot finish the setup.
		await expect(ownerCallback(env, source, tokenOf(32, 10))).rejects.toMatchObject({ httpStatus: 409 })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ phase: 'awaiting_manifest_callback' })

		// The administrator opening the console's page keeps the link's own expiry.
		await manifestHandoff(deps(env, source, new Request(`${ORIGIN}/api/source/github/manifest/${connectionId}`), auth(), now), connectionId)
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ expiresAt: 1_000 + HANDOFF_TTL })

		clock = 1_000 + HANDOFF_TTL
		await expect(open(env, source, second.url, connectionId, now)).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('the link itself checks its expiry, even when no cleanup ended the setup yet', async () => {
		let clock = 1_000
		const now = () => clock
		const harness = environment(now)
		const env: Env = { ...harness, REPOSITORIES: { ...harness.REPOSITORIES, githubConnections: new NoReapStore(harness.DB, now) } }
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source, now)
		const handoff = await mint(env, source, connectionId, 9, auth(), now)
		clock = handoff.expiresAt
		await expect(open(env, source, handoff.url, connectionId, now)).rejects.toMatchObject({ httpStatus: 404 })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ status: 'active' })
	})

	test('takes no callback or setup without a session for an attempt nobody minted a link for', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		await expect(ownerCallback(env, source, token(32))).rejects.toMatchObject({ httpStatus: 409 })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ phase: 'awaiting_manifest_callback' })

		await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		source.calls.splice(0)
		await expect(ownerSetup(env, source, connectionId, '?installation_id=456&setup_action=install')).rejects.toMatchObject({ httpStatus: 404 })
		expect(source.calls).toEqual([])
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toBeNull()
	})

	test('tells the owner to hand back when the installation cannot be verified or awaits approval', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		await mint(env, source, connectionId)
		await ownerCallback(env, source)
		expect(await (await ownerSetup(env, source, connectionId, '?setup_action=request')).text()).toContain('Waiting for approval')
		expect(await (await ownerSetup(env, source, connectionId, '?installation_id=999&setup_action=install')).text()).toContain(
			'ask your administrator to verify it',
		)
		expect(await env.REPOSITORIES.githubConnections.getConnectionById(connectionId)).toBeNull()
	})

	test('refuses the owner with a page in the words an owner can act on, never the console JSON', async () => {
		for (
			const [status, words] of [[400, 'incomplete'], [404, 'not valid any more'], [409, 'not valid any more'], [422, 'another account'], [
				503,
				'Tell your administrator',
			]] as const
		) {
			const refusal = handoffRefusal(status)
			expect(refusal.status).toBe(status)
			expect(refusal.headers.get('content-type')).toBe('text/html; charset=utf-8')
			expect(refusal.headers.get('cache-control')).toBe('no-store')
			expect(await refusal.text()).toContain(words)
		}
	})

	test('lasts as long as the administrator asks, from 10 minutes to 24 hours', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		expect((await mint(env, source, connectionId, 9, auth(), () => 1_000, 24 * 60 * 60)).expiresAt).toBe(1_000 + 24 * 60 * 60)
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ expiresAt: 1_000 + 24 * 60 * 60 })
		for (const span of [599, 24 * 60 * 60 + 1, 1.5]) {
			await expect(mint(env, source, connectionId, 9, auth(), () => 1_000, span)).rejects.toMatchObject({ httpStatus: 400 })
		}
	})

	test('replays of the manifest state are refused, through either callback', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		await mint(env, source, connectionId)
		expect((await ownerCallback(env, source)).status).toBe(303)
		await expect(ownerCallback(env, source)).rejects.toMatchObject({ httpStatus: 409 })
		await expect(consoleCallback(env, source)).rejects.toMatchObject({ httpStatus: 409 })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ phase: 'installation_required', stateHash: null })
	})

	test('a cancel ends the setup, its link and its state, and frees the slot for a new setup', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		const handoff = await mint(env, source, connectionId)
		await expect(cancelSourceConnection(deps(env, source, mutationRequest('/api/rpc'), auth('service')), connectionId)).rejects.toMatchObject({
			httpStatus: 403,
		})

		// Another administrator may cancel it: the one who started it may be away.
		const other = { ...auth(), principal: { id: 'user-2', type: 'user' as const, label: 'other@example.test' } }
		expect(await cancelSourceConnection(deps(env, source, mutationRequest('/api/rpc'), other), connectionId)).toEqual({ connectionId })
		expect(other.events).toEqual([{ action: 'source.connection.cancel', resourceType: 'source_connection', resourceId: connectionId }])
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({
			status: 'failed',
			lastErrorCode: 'cancelled',
			stateHash: null,
			manifestStateSecretRef: null,
		})
		expect((await queryRowsFromEnv(env, 'SELECT * FROM vault')).length).toBe(0)
		await expect(open(env, source, handoff.url, connectionId)).rejects.toMatchObject({ httpStatus: 404 })
		await expect(ownerCallback(env, source)).rejects.toMatchObject({ httpStatus: 409 })
		await expect(cancelSourceConnection(deps(env, source, mutationRequest('/api/rpc')), connectionId)).rejects.toMatchObject({ httpStatus: 404 })
		expect(await started(env, source)).not.toBe(connectionId)
	})

	test('a setup is not cancelled once GitHub created its App', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		await consoleCallback(env, source)
		await expect(cancelSourceConnection(deps(env, source, mutationRequest('/api/rpc')), connectionId)).rejects.toMatchObject({ httpStatus: 404 })
		expect(await env.REPOSITORIES.githubConnections.getAttempt(connectionId)).toMatchObject({ status: 'active', phase: 'installation_required' })
	})

	test('only the person who started the setup mints a link, and only while it waits for GitHub', async () => {
		const env = environment()
		const source = new FakeSourceConnection()
		const connectionId = await started(env, source)
		const other = { ...auth(), principal: { id: 'user-2', type: 'user' as const, label: 'other@example.test' } }
		await expect(mint(env, source, connectionId, 9, other)).rejects.toMatchObject({ httpStatus: 404 })
		await expect(mint(env, source, connectionId, 9, auth('service'))).rejects.toMatchObject({ httpStatus: 403 })
		await expect(mint(env, source, connectionId, 9, auth('user', false))).rejects.toMatchObject({ httpStatus: 403 })
		await manifestCallback({
			...deps(env, source, new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${token(32)}`)),
			exchangeManifest: () => Promise.resolve(createdApp()),
		})
		await expect(mint(env, source, connectionId)).rejects.toMatchObject({ httpStatus: 404 })
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

/** A random-bytes source whose every draw differs: the first is filled with `first`, the next with `first + 1`, … */
function drawsFrom(first: number): (length: number) => Uint8Array {
	let next = first
	return (length) => new Uint8Array(length).fill(next++)
}

async function sha256Hex(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function token(length: number): string {
	return tokenOf(length, 7)
}

function tokenOf(length: number, fill: number): string {
	let binary = ''
	for (const byte of new Uint8Array(length).fill(fill)) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function queryRowsFromEnv(env: Env, sql: string): Promise<Record<string, unknown>[]> {
	return env.DB.prepare(sql).all<Record<string, unknown>>().then((result) => result.results)
}

function vaultOf(env: Env): Promise<Vault> {
	return Vault.create(env.DB, testKey())
}
