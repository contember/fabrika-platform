import type { SqlDatabase, SqlQueryResult, SqlStatement } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import {
	githubAppCredentialSecretLabel,
	GitHubConnectionCasError,
	GitHubConnectionStore,
	GitHubConnectionWebhookSecretProvider,
	githubManifestStateSecretLabel,
	type GitHubSetupAttempt,
	githubWebhookSecretLabel,
	type PublishGitHubConnectionInput,
} from '../github-connection-store'
import { connectionDto, workflowDto } from '../source-connection/status'
import { Vault } from '../vault'
import { createHarness, createHarnessThrough, type Harness, migrationsAfter, queryRows } from './helpers/harness'

function testKey(): string {
	let binary = ''
	for (let i = 0; i < 32; i++) binary += String.fromCharCode(i + 1)
	return btoa(binary)
}

const STATE_DIGEST = 'a'.repeat(64)
const OTHER_STATE_DIGEST = 'b'.repeat(64)
const LEGACY_DIGEST = 'c'.repeat(64)

function insertKeyedConnection(sqlite: Harness['sqlite'], connectionId: string, owner: string, installationId: number): void {
	sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, '123', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '["acme/app"]', '["acme/app"]', 'principal-1', 800, 900, 1)`)
		.run(
			connectionId,
			`${connectionId}-app`,
			`https://github.com/apps/${connectionId}-app`,
			owner,
			`${connectionId}-app`,
			`vault:${connectionId}-credential`,
			`https://control.example/webhooks/github/${connectionId}`,
			`vault:${connectionId}-webhook`,
			installationId,
			owner.toLowerCase(),
		)
}

/** Drive one manifest attempt to `app_verified`, which is where every post-verification test starts. */
async function attemptAtAppVerified(
	store: GitHubConnectionStore,
	vault: Vault,
	id: string,
	expiresAt: number,
	options: { readonly owner?: string; readonly appId?: string; readonly appSlug?: string } = {},
): Promise<GitHubSetupAttempt> {
	const owner = options.owner ?? 'acme'
	const appSlug = options.appSlug ?? 'source'
	const state = await vault.prepareSecret('platform', githubManifestStateSecretLabel(id), 'opaque-state')
	await store.beginAttemptWithManifestState({
		id,
		stateHash: STATE_DIGEST,
		initiatedBy: 'alice',
		expectedOrigin: 'https://control.example',
		desiredOwner: owner,
		desiredAppName: appSlug,
		desiredPublic: false,
		requestedRepositories: [],
		expiresAt,
	}, state)
	const claimed = await store.claimCallback(STATE_DIGEST, 'alice')
	if (claimed === null) throw new Error('claim failed')
	const credential = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(id), 'credential')
	const stored = await store.storeSecretAndCheckpoint(id, claimed.version, 'exchange_claimed', 'credential_stored', 'app-credential', credential)
	if (stored === null) throw new Error('credential checkpoint failed')
	const verified = await store.checkpoint(id, stored.version, 'credential_stored', 'app_verified', {
		appId: options.appId ?? '123',
		appSlug,
		appHtmlUrl: `https://github.com/apps/${appSlug}`,
	})
	if (verified === null) throw new Error('App verification checkpoint failed')
	return verified
}

class TwoPartyBarrier {
	private arrivals = 0
	private readonly ready = Promise.withResolvers<void>()

	wait(): Promise<void> {
		this.arrivals += 1
		if (this.arrivals === 2) this.ready.resolve()
		return this.ready.promise
	}
}

class BarrierDatabase implements SqlDatabase {
	constructor(private readonly inner: SqlDatabase, private readonly barrier: TwoPartyBarrier) {}

	prepare(sql: string): SqlStatement {
		return this.inner.prepare(sql)
	}

	async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		await this.barrier.wait()
		return this.inner.batch<T>(statements)
	}
}

class FirstBatchGateDatabase implements SqlDatabase {
	private readonly arrival = Promise.withResolvers<void>()
	private readonly releaseGate = Promise.withResolvers<void>()
	private first = true

	constructor(private readonly inner: SqlDatabase) {}

	prepare(sql: string): SqlStatement {
		return this.inner.prepare(sql)
	}

	async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		if (this.first) {
			this.first = false
			this.arrival.resolve()
			await this.releaseGate.promise
		}
		return this.inner.batch<T>(statements)
	}

	waitUntilBlocked(): Promise<void> {
		return this.arrival.promise
	}

	release(): void {
		this.releaseGate.resolve()
	}
}

async function configuredAttempt() {
	const harness = createHarness(() => 1_000)
	const store = harness.repositories.githubConnections
	const vault = await Vault.create(harness.d1, testKey(), () => 1_000)
	const stateSecret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('attempt-1'), 'opaque-state')
	const started = await store.beginAttemptWithManifestState({
		id: 'attempt-1',
		stateHash: STATE_DIGEST,
		initiatedBy: 'principal-1',
		expectedOrigin: 'https://control.example',
		desiredOwner: 'acme',
		desiredAppName: 'fabrika-source',
		desiredPublic: false,
		requestedRepositories: ['acme/z', 'acme/a', 'acme/a'],
		expiresAt: 2_000,
	}, stateSecret)
	const claimed = await store.claimCallback(STATE_DIGEST, 'principal-1')
	if (claimed === null) throw new Error('claim failed')
	const credential = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'app-credential')
	const credentialStored = await store.storeSecretAndCheckpoint(
		started.id,
		claimed.version,
		'exchange_claimed',
		'credential_stored',
		'app-credential',
		credential,
	)
	if (credentialStored === null) throw new Error('credential checkpoint failed')
	const verified = await store.checkpoint(started.id, credentialStored.version, 'credential_stored', 'app_verified', {
		appId: '123',
		appSlug: 'fabrika-source',
		appHtmlUrl: 'https://github.com/apps/fabrika-source',
	})
	if (verified === null) throw new Error('App verification checkpoint failed')
	const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(started.id), 'webhook-value')
	const webhookStored = await store.storeSecretAndCheckpoint(
		started.id,
		verified.version,
		'app_verified',
		'webhook_secret_stored',
		'webhook',
		webhook,
	)
	if (webhookStored === null) throw new Error('webhook checkpoint failed')
	const webhookConfigured = await store.checkpoint(started.id, webhookStored.version, 'webhook_secret_stored', 'webhook_configured')
	if (webhookConfigured === null) throw new Error('webhook config checkpoint failed')
	const ready = await store.checkpoint(started.id, webhookConfigured.version, 'webhook_configured', 'installation_required')
	if (ready === null) throw new Error('installation checkpoint failed')
	return { ...harness, store, vault, started, claimed, credential, webhook, ready }
}

describe('GitHubConnectionStore', () => {
	test('drops the singleton table and every legacy row, leaving a legacy-bound app failing closed', async () => {
		const harness = createHarnessThrough('0020_github_manifest_state.sql', () => 1_000)
		const { sqlite } = harness
		sqlite.query(`INSERT INTO github_source_connections (
			singleton, connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
			credential_sha256, webhook_url, webhook_secret_ref, installation_id,
			installation_account_login, installation_selection, verified_repositories_json,
			requested_repositories_json, connected_by, connected_at, verified_at, version
		) VALUES (1, ?, '123', 'legacy-app', 'https://github.com/apps/legacy-app', 'Acme', 'legacy-app', 0,
			?, 'https://control.example/webhooks/github', 'vault:legacy-webhook', 45,
			'acme', 'all', '["acme/app"]', '["acme/app"]', 'principal-1', 800, 900, 3)`)
			.run('legacy-connection', LEGACY_DIGEST)
		for (const [id, installationId] of [['zerops-match', 45], ['cloudflare-only', 45]] as const) {
			sqlite.query('INSERT INTO apps (id, repo_url, github_installation_id) VALUES (?, ?, ?)')
				.run(id, `github.com/acme/${id}`, installationId)
		}
		const insertEnvironment = sqlite.query(`INSERT INTO app_envs (
			app_id, env, provider, provider_target_json, provider_artifact_json
		) VALUES (?, ?, ?, '{}', '{}')`)
		insertEnvironment.run('zerops-match', 'prod', 'zerops')
		insertEnvironment.run('cloudflare-only', 'prod', 'cloudflare')
		// An adoption attempt could not decode once `setup_kind` stops being read, so it must not survive.
		sqlite.query(`INSERT INTO github_source_setup_attempts (
			id, setup_kind, status, phase, version, initiated_by, expected_origin, desired_owner, desired_app_name,
			desired_public, requested_repositories_json, app_id, app_slug, app_html_url, credential_sha256,
			webhook_secret_ref, created_at, updated_at, expires_at
		) VALUES ('adopted', 'adoption', 'active', 'webhook_configured', 1, 'principal-1',
			'https://control.example', 'acme', 'legacy-app', 0, '[]', '123', 'legacy-app',
			'https://github.com/apps/legacy-app', ?, 'vault:adopted-webhook', 1, 1, 9999)`)
			.run(LEGACY_DIGEST)

		sqlite.exec(migrationsAfter('0020_github_manifest_state.sql'))

		expect(() => queryRows(sqlite, 'SELECT * FROM github_source_connections')).toThrow()
		expect(queryRows(sqlite, `SELECT connection_id FROM github_source_connections_keyed`)).toEqual([])
		expect(queryRows(sqlite, `SELECT id FROM github_source_setup_attempts`)).toEqual([])
		// The 0021 backfill still ran, so the row keeps pointing at a connection that is gone: the
		// binding fails closed rather than resolving to some other organization's credential.
		expect(queryRows(sqlite, 'SELECT id, github_connection_id FROM apps ORDER BY id')).toEqual([
			{ id: 'cloudflare-only', github_connection_id: null },
			{ id: 'zerops-match', github_connection_id: 'legacy-connection' },
		])
		await expect(harness.repositories.registry.getSourceBinding('zerops-match', 'connection')).rejects.toThrow('incomplete')
		expect(await harness.repositories.registry.getSourceBinding('cloudflare-only', 'installation')).toEqual({ installationId: 45 })
	})

	test('keeps keyed connections unique per owner and paged', async () => {
		const harness = createHarness(() => 1_000)
		const { sqlite } = harness
		insertKeyedConnection(sqlite, 'keyed-alpha', 'Acme', 45)
		insertKeyedConnection(sqlite, 'keyed-beta', 'Beta', 46)
		insertKeyedConnection(sqlite, 'keyed-gamma', 'Gamma', 47)
		expect(() => insertKeyedConnection(sqlite, 'keyed-beta-duplicate', 'beta', 48)).toThrow()
		expect((await harness.repositories.githubConnections.getConnectionByOwner('ACME'))?.connectionId).toBe('keyed-alpha')

		const firstPage = await harness.repositories.githubConnections.listConnections({ limit: 2 })
		expect(firstPage.items.map((connection) => connection.connectionId)).toEqual(['keyed-alpha', 'keyed-beta'])
		expect(firstPage.nextCursor).toBe('keyed-beta')
		expect((await harness.repositories.githubConnections.listConnections({ cursor: firstPage.nextCursor ?? '', limit: 2 })).items
			.map((connection) => connection.connectionId)).toEqual(['keyed-gamma'])
		await expect(harness.repositories.githubConnections.listConnections({ limit: 0 })).rejects.toThrow('page size')
		await expect(harness.repositories.githubConnections.listConnections({ limit: 101 })).rejects.toThrow('page size')
		await expect(harness.repositories.githubConnections.listConnections({ cursor: 'x'.repeat(513) })).rejects.toThrow('cursor')

		sqlite.query('INSERT INTO apps (id, repo_url, github_connection_id, github_installation_id) VALUES (?, ?, ?, ?)')
			.run('zerops-match', 'github.com/acme/zerops-match', 'keyed-alpha', 45)
		sqlite.query(`INSERT INTO app_envs (app_id, env, provider, provider_target_json, provider_artifact_json)
			VALUES ('zerops-match', 'prod', 'zerops', '{}', '{}')`).run()
		expect(await harness.repositories.registry.getSourceBinding('zerops-match', 'connection')).toEqual({
			connectionId: 'keyed-alpha',
			installationId: 45,
		})
		expect(
			(await harness.repositories.registry.getAppsByRepoUrlAndSourceConnection('github.com/acme/zerops-match', 'keyed-alpha', 45))
				.map((app) => app.id),
		).toEqual(['zerops-match'])
		expect(
			await harness.repositories.registry.replaceAppGitHubSourceBinding('zerops-match', { connectionId: null, installationId: null }),
		).toMatchObject({ github_connection_id: null, github_installation_id: null })
		expect(
			await harness.repositories.registry.replaceAppGitHubSourceBinding('zerops-match', { connectionId: 'keyed-alpha', installationId: 45 }),
		).toMatchObject({ github_connection_id: 'keyed-alpha', github_installation_id: 45 })
	})

	test('an unconnected connection id resolves no webhook secret', async () => {
		const harness = createHarness(() => 1_000)
		const provider = new GitHubConnectionWebhookSecretProvider(
			harness.repositories.githubConnections,
			await Vault.create(harness.d1, testKey()),
			'unknown-connection',
		)
		expect(await provider.getSecret()).toBeNull()
	})

	test('expires an unclaimed callback atomically, removes its capability, and permits a new attempt', async () => {
		let clock = 100
		const { d1 } = createHarness(() => clock)
		const store = new GitHubConnectionStore(d1, () => clock, 10)
		const vault = await Vault.create(d1, testKey(), () => clock)
		const stateSecret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('expired'), 'opaque-state')
		await store.beginAttemptWithManifestState({
			id: 'expired',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 110,
		}, stateSecret)
		clock = 110
		expect(await store.getWorkflowAttempt()).toBeNull()
		const expired = await store.getAttempt('expired')
		expect(expired).toMatchObject({ status: 'failed', lastErrorCode: 'callback_expired', manifestStateSecretRef: null })
		await expect(vault.getSecret(stateSecret.ref)).rejects.toThrow()
		const nextSecret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('next'), 'next-state')
		await expect(store.beginAttemptWithManifestState({
			id: 'next',
			stateHash: OTHER_STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 120,
		}, nextSecret)).resolves.toMatchObject({ id: 'next' })
	})

	test('fails closed and unblocks setup when an expired manifest secret has the wrong purpose', async () => {
		let clock = 100
		const { d1, sqlite } = createHarness(() => clock)
		const store = new GitHubConnectionStore(d1, () => clock, 10)
		const vault = await Vault.create(d1, testKey(), () => clock)
		const secret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('tampered'), 'opaque-state')
		await store.beginAttemptWithManifestState({
			id: 'tampered',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 110,
		}, secret)
		sqlite.query(`UPDATE vault SET scope = 'app' WHERE id = ?`).run(secret.id)
		clock = 110
		expect(await store.getWorkflowAttempt()).toBeNull()
		expect(await store.getAttempt('tampered')).toMatchObject({ status: 'failed', manifestStateSecretRef: null })
		expect(queryRows(sqlite, 'SELECT id FROM vault WHERE id = ?', secret.id)).toHaveLength(1)
	})

	test('callback claim wins the expiry boundary and renews the operation lease', async () => {
		let clock = 100
		const { d1 } = createHarness(() => clock)
		const store = new GitHubConnectionStore(d1, () => clock, 10)
		const vault = await Vault.create(d1, testKey(), () => clock)
		const secret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('claimed'), 'opaque-state')
		await store.beginAttemptWithManifestState({
			id: 'claimed',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 101,
		}, secret)
		const claimed = await store.claimCallback(STATE_DIGEST, 'alice')
		expect(claimed).toMatchObject({ phase: 'exchange_claimed', expiresAt: 110 })
		clock = 101
		expect(await store.getWorkflowAttempt()).toMatchObject({ status: 'active', phase: 'exchange_claimed' })
		clock = 110
		expect(await store.getWorkflowAttempt()).toBeNull()
		expect(await store.getAttempt('claimed')).toMatchObject({ status: 'failed', phase: 'exchange_claimed' })
	})

	test('turns a crashed durable phase into repair after its lease', async () => {
		let clock = 100
		const { d1 } = createHarness(() => clock)
		const store = new GitHubConnectionStore(d1, () => clock, 10)
		const vault = await Vault.create(d1, testKey(), () => clock)
		const stateSecret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('manifest-crash'), 'opaque-state')
		await store.beginAttemptWithManifestState({
			id: 'manifest-crash',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 110,
		}, stateSecret)
		const claimed = await store.claimCallback(STATE_DIGEST, 'alice')
		if (claimed === null) throw new Error('claim failed')
		const credential = await vault.prepareSecret('platform', githubAppCredentialSecretLabel('manifest-crash'), 'credential')
		const stored = await store.storeSecretAndCheckpoint(
			'manifest-crash',
			claimed.version,
			'exchange_claimed',
			'credential_stored',
			'app-credential',
			credential,
		)
		if (stored === null) throw new Error('credential checkpoint failed')
		clock = 110
		expect(await store.getWorkflowAttempt()).toMatchObject({ status: 'repair_required', id: 'manifest-crash', phase: 'credential_stored' })

		const { d1: activatedDb } = createHarness(() => clock)
		const activatedStore = new GitHubConnectionStore(activatedDb, () => clock, 10)
		const activatedVault = await Vault.create(activatedDb, testKey(), () => clock)
		await attemptAtAppVerified(activatedStore, activatedVault, 'verification-crash', 120)
		clock = 120
		expect(await activatedStore.getWorkflowAttempt()).toMatchObject({ status: 'repair_required', id: 'verification-crash', phase: 'app_verified' })
	})

	test('reaps every post-verification checkpoint, including remote-call-before-checkpoint windows', async () => {
		for (const target of ['webhook_secret_stored', 'webhook_configured']) {
			let clock = 100
			const { d1 } = createHarness(() => clock)
			const store = new GitHubConnectionStore(d1, () => clock, 10)
			const vault = await Vault.create(d1, testKey(), () => clock)
			let attempt = await attemptAtAppVerified(store, vault, `crash-${target}`, 110)
			const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(attempt.id), 'webhook')
			const stored = await store.storeSecretAndCheckpoint(
				attempt.id,
				attempt.version,
				'app_verified',
				'webhook_secret_stored',
				'webhook',
				webhook,
			)
			if (stored === null) throw new Error('webhook checkpoint failed')
			attempt = stored
			if (target === 'webhook_configured') {
				const configured = await store.checkpoint(attempt.id, attempt.version, 'webhook_secret_stored', 'webhook_configured')
				if (configured === null) throw new Error('webhook configuration checkpoint failed')
				attempt = configured
			}
			clock = 110
			expect(await store.getWorkflowAttempt()).toMatchObject({ status: 'repair_required', id: attempt.id, phase: target })
		}
	})

	test('claims a callback once and binds it to the initiating principal', async () => {
		const { repositories, d1 } = createHarness(() => 100)
		const store = repositories.githubConnections
		const vault = await Vault.create(d1, testKey())
		const stateSecret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('a'), 'opaque-state')
		await store.beginAttemptWithManifestState({
			id: 'a',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 200,
		}, stateSecret)
		expect(await store.claimCallback(STATE_DIGEST, 'bob')).toBeNull()
		const claimed = await store.claimCallback(STATE_DIGEST, 'alice')
		expect(claimed?.phase).toBe('exchange_claimed')
		expect(claimed?.stateHash).toBeNull()
		expect(await store.claimCallback(STATE_DIGEST, 'alice')).toBeNull()
	})

	test('expires callback capabilities and permits only one active setup', async () => {
		let clock = 100
		const { repositories, d1, sqlite } = createHarness(() => clock)
		const store = repositories.githubConnections
		const vault = await Vault.create(d1, testKey(), () => clock)
		const firstState = await vault.prepareSecret('platform', githubManifestStateSecretLabel('a'), 'first-state')
		const nextState = await vault.prepareSecret('platform', githubManifestStateSecretLabel('b'), 'next-state')
		const input = {
			id: 'a',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 200,
		}
		const started = await store.beginAttemptWithManifestState(input, firstState)
		await expect(store.beginAttemptWithManifestState({ ...input, id: 'b', stateHash: OTHER_STATE_DIGEST }, nextState)).rejects.toThrow(
			'could not be started',
		)
		expect(await store.getAttempt('b')).toBeNull()
		expect(queryRows(sqlite, 'SELECT id FROM vault WHERE id = ?', nextState.id)).toEqual([])
		clock = 200
		expect(await store.claimCallback(STATE_DIGEST, 'alice')).toBeNull()
		const failed = await store.markFailed(started.id, started.version, 'callback_expired')
		expect(failed?.status).toBe('failed')
		expect(failed?.stateHash).toBeNull()
		await expect(store.beginAttemptWithManifestState({ ...input, id: 'b', stateHash: OTHER_STATE_DIGEST, expiresAt: 300 }, nextState))
			.resolves.toMatchObject({ id: 'b' })
	})

	test('uses CAS transitions and commits a platform secret with its checkpoint', async () => {
		const flow = await configuredAttempt()
		expect(flow.ready.requestedRepositories).toEqual(['acme/a', 'acme/z'])
		expect(await flow.store.checkpoint(flow.started.id, flow.claimed.version, 'exchange_claimed', 'credential_stored')).toBeNull()
		expect(
			await flow.vault.getSecretForPurpose(flow.credential.ref, {
				scope: 'platform',
				label: githubAppCredentialSecretLabel(flow.started.id),
			}),
		).toBe('app-credential')
		await expect(flow.vault.getSecretForPurpose(flow.credential.ref, {
			scope: 'platform',
			label: githubWebhookSecretLabel(flow.started.id),
		})).rejects.toThrow('purpose mismatch')
	})

	test('keeps the App credential in the vault through publishing and exposes only redacted state', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		const installationAttempt = await flow.store.getWorkflowAttempt()
		if (installationAttempt === null) throw new Error('installation workflow missing')
		const installationState = workflowDto('harbor', installationAttempt)
		expect(installationState).toMatchObject({
			state: 'installation-required',
			connectionId: flow.started.id,
			installationUrl: 'https://github.com/apps/fabrika-source/installations/new',
		})
		expect(JSON.stringify(installationState)).not.toContain('vault:')
		expect(JSON.stringify(installationState)).not.toContain(STATE_DIGEST)
		const connection = await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		expect(connection).toMatchObject({ appOwner: 'acme', appCredentialRef: flow.credential.ref })
		expect(await flow.store.getAttempt(flow.started.id)).toMatchObject({ status: 'completed', appCredentialRef: flow.credential.ref })
		expect(
			await flow.vault.getSecretForPurpose(flow.credential.ref, { scope: 'platform', label: githubAppCredentialSecretLabel(flow.started.id) }),
		).toBe('app-credential')
		const published = await flow.store.getConnectionById(flow.started.id)
		if (published === null) throw new Error('published connection missing')
		const state = connectionDto('harbor', published)
		expect(state.state).toBe('connected')
		const serialized = JSON.stringify(state)
		expect(serialized).not.toContain('vault:')
		expect(serialized).not.toContain(STATE_DIGEST)

		const provider = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault, flow.started.id)
		expect(await provider.getSecret()).toBe('webhook-value')
	})

	test('keeps installation-required stable after the operation lease expires', async () => {
		let clock = 100
		const { d1 } = createHarness(() => clock)
		const store = new GitHubConnectionStore(d1, () => clock, 10)
		const vault = await Vault.create(d1, testKey(), () => clock)
		const adopted = await attemptAtAppVerified(store, vault, 'installation-wait', 110, { appSlug: 'fabrika-source' })
		const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(adopted.id), 'webhook-value')
		const stored = await store.storeSecretAndCheckpoint(
			adopted.id,
			adopted.version,
			'app_verified',
			'webhook_secret_stored',
			'webhook',
			webhook,
		)
		if (stored === null) throw new Error('webhook checkpoint failed')
		const configured = await store.checkpoint(stored.id, stored.version, 'webhook_secret_stored', 'webhook_configured')
		if (configured === null) throw new Error('webhook configuration failed')
		const waiting = await store.checkpoint(configured.id, configured.version, 'webhook_configured', 'installation_required')
		if (waiting === null) throw new Error('installation checkpoint failed')

		clock = 1_000
		const workflow = await store.getWorkflowAttempt()
		if (workflow === null) throw new Error('installation workflow missing')
		expect(workflowDto('harbor', workflow)).toMatchObject({ state: 'installation-required', connectionId: adopted.id })
		expect(await store.getAttempt(adopted.id)).toMatchObject({ status: 'active', phase: 'installation_required' })
		// The scoped webhook is already configured at this phase, so deliveries must keep verifying while
		// the attempt waits for the human to install the App.
		expect(await new GitHubConnectionWebhookSecretProvider(store, vault, adopted.id).getSecret()).toBe('webhook-value')
	})

	test('rejects malformed durable state instead of guessing a phase', async () => {
		const { repositories, sqlite, d1 } = createHarness(() => 100)
		const vault = await Vault.create(d1, testKey(), () => 100)
		const state = await vault.prepareSecret('platform', githubManifestStateSecretLabel('a'), 'opaque-state')
		await repositories.githubConnections.beginAttemptWithManifestState({
			id: 'a',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 200,
		}, state)
		sqlite.exec('PRAGMA ignore_check_constraints = ON')
		sqlite.query(`UPDATE github_source_setup_attempts SET phase = 'made_up' WHERE id = 'a'`).run()
		await expect(repositories.githubConnections.getAttempt('a')).rejects.toThrow('invalid GitHub setup phase')
	})

	test('refuses to publish mismatched webhook, installation owner, or verified repository scope', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		const base: PublishGitHubConnectionInput = {
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		}
		expect(await flow.store.publishConnection({ ...base, webhookUrl: 'https://evil.example/webhooks/github' })).toBeNull()
		expect(await flow.store.publishConnection({ ...base, installationAccountLogin: 'other' })).toBeNull()
		expect(await flow.store.publishConnection({ ...base, verifiedRepositories: ['acme/a'] })).toBeNull()
		expect(await flow.store.getConnection()).toBeNull()
	})

	test('a stale CAS does not leave ciphertext behind', async () => {
		const flow = await configuredAttempt()
		const stale = await flow.vault.prepareSecret('platform', githubWebhookSecretLabel(flow.started.id), 'must-not-persist')
		await expect(
			flow.store.storeSecretAndCheckpoint(
				flow.started.id,
				1,
				'app_verified',
				'webhook_secret_stored',
				'webhook',
				stale,
			),
		).rejects.toBeInstanceOf(GitHubConnectionCasError)
		expect(queryRows(flow.sqlite, 'SELECT id FROM vault WHERE id = ?', stale.id)).toEqual([])
	})

	test('a batch barrier gives exactly one secret-checkpoint CAS winner', async () => {
		const harness = createHarness(() => 1_000)
		const vault = await Vault.create(harness.d1, testKey(), () => 1_000)
		const stateSecret = await vault.prepareSecret('platform', githubManifestStateSecretLabel('contended-attempt'), 'opaque-state')
		const started = await harness.repositories.githubConnections.beginAttemptWithManifestState({
			id: 'contended-attempt',
			stateHash: STATE_DIGEST,
			initiatedBy: 'principal-1',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 2_000,
		}, stateSecret)
		const claimed = await harness.repositories.githubConnections.claimCallback(STATE_DIGEST, 'principal-1')
		if (claimed === null) throw new Error('callback claim failed')
		const first = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'first')
		const second = await vault.prepareSecret('platform', githubAppCredentialSecretLabel(started.id), 'second')
		const barrier = new TwoPartyBarrier()
		const left = new GitHubConnectionStore(new BarrierDatabase(harness.d1, barrier), () => 1_000)
		const right = new GitHubConnectionStore(new BarrierDatabase(harness.d1, barrier), () => 1_000)
		const outcomes = await Promise.allSettled([
			left.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'credential_stored', 'app-credential', first),
			right.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'credential_stored', 'app-credential', second),
		])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
		expect(queryRows(harness.sqlite, 'SELECT id FROM vault')).toHaveLength(1)
		expect((await harness.repositories.githubConnections.getAttempt(started.id))?.phase).toBe('credential_stored')
	})

	test('a batch barrier gives exactly one connection-publish CAS winner', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		const barrier = new TwoPartyBarrier()
		const left = new GitHubConnectionStore(new BarrierDatabase(flow.d1, barrier), () => 1_000)
		const right = new GitHubConnectionStore(new BarrierDatabase(flow.d1, barrier), () => 1_000)
		const input: PublishGitHubConnectionInput = {
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		}
		const outcomes = await Promise.allSettled([left.publishConnection(input), right.publishConnection(input)])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
		expect(await flow.store.getConnection()).not.toBeNull()
		expect((await flow.store.getAttempt(flow.started.id))?.status).toBe('completed')
	})

	test('a publish between owner preflight and atomic start rolls back the attempt and manifest secret', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		const gate = new FirstBatchGateDatabase(flow.d1)
		const delayedStart = new GitHubConnectionStore(gate, () => 1_000)
		expect(await delayedStart.getConnectionByOwner('ACME')).toBeNull()
		const stateSecret = await flow.vault.prepareSecret('platform', githubManifestStateSecretLabel('late-start'), 'late-state')
		const start = delayedStart.beginAttemptWithManifestState({
			id: 'late-start',
			stateHash: OTHER_STATE_DIGEST,
			initiatedBy: 'principal-2',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'ACME',
			desiredAppName: 'late-source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 2_000,
		}, stateSecret)
		await gate.waitUntilBlocked()
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		gate.release()
		await expect(start).rejects.toThrow('could not be started')
		expect(await flow.store.getAttempt('late-start')).toBeNull()
		expect(queryRows(flow.sqlite, 'SELECT id FROM vault WHERE id = ?', stateSecret.id)).toEqual([])
		expect((await flow.store.getConnectionByOwner('acme'))?.connectionId).toBe(flow.started.id)
	})

	test('connection publish requires the exact webhook platform purpose and rolls back', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		const webhookId = flow.webhook.ref.slice('vault:'.length)
		flow.sqlite.query(`UPDATE vault SET label = 'platform:github-source:other:webhook' WHERE id = ?`).run(webhookId)
		await expect(flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})).rejects.toBeInstanceOf(GitHubConnectionCasError)
		expect((await flow.store.getAttempt(flow.started.id))?.phase).toBe('installation_required')
		expect(await flow.store.getConnection()).toBeNull()
	})

	test('requires repair state instead of hiding a vault-held App credential in a failed row', async () => {
		const flow = await configuredAttempt()
		expect(await flow.store.markFailed(flow.started.id, flow.ready.version, 'installation_verification')).toBeNull()
		const repair = await flow.store.markRepairRequired(flow.started.id, flow.ready.version, 'installation_verification')
		expect(repair?.status).toBe('repair_required')
		expect(repair?.appCredentialRef).toBe(flow.credential.ref)
	})

	test('dynamic provider honors caller cancellation without returning a secret', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		const controller = new AbortController()
		controller.abort()
		const provider = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault, flow.started.id)
		await expect(provider.getSecret(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
	})

	test('switches webhook authority once the webhook is configured and keeps it after publish', async () => {
		const flow = await configuredAttempt()
		const provider = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault, flow.started.id)
		const ready = flow.ready
		expect(await provider.getSecret()).toBe('webhook-value')
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		expect(await provider.getSecret()).toBe('webhook-value')
	})

	test('fails a connected webhook whose stored secret is gone instead of resolving another', async () => {
		const flow = await configuredAttempt()
		const ready = flow.ready
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github/attempt-1',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		await flow.vault.delete(flow.webhook.ref)
		const connected = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault, flow.started.id)
		await expect(connected.getSecret()).rejects.toThrow('unresolvable vault ref')
	})
})
