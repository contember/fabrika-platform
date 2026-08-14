import type { SqlDatabase, SqlQueryResult, SqlStatement } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import {
	GitHubConnectionCasError,
	GitHubConnectionStore,
	GitHubConnectionWebhookSecretProvider,
	githubManifestStateSecretLabel,
	githubRecoverySecretLabel,
	githubWebhookSecretLabel,
	type PublishGitHubConnectionInput,
} from '../github-connection-store'
import { Vault } from '../vault'
import { createHarness, queryRows } from './helpers/harness'

function testKey(): string {
	let binary = ''
	for (let i = 0; i < 32; i++) binary += String.fromCharCode(i + 1)
	return btoa(binary)
}

const STATE_DIGEST = 'a'.repeat(64)
const OTHER_STATE_DIGEST = 'b'.repeat(64)
const CREDENTIAL_DIGEST = 'c'.repeat(64)

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
	const recovery = await vault.prepareSecret('platform', githubRecoverySecretLabel(started.id), 'one-time-pem')
	const recovered = await store.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'recovery_stored', 'recovery', recovery)
	if (recovered === null) throw new Error('recovery checkpoint failed')
	const written = await store.checkpoint(started.id, recovered.version, 'recovery_stored', 'source_bundle_written', {
		credentialSha256: CREDENTIAL_DIGEST,
	})
	if (written === null) throw new Error('source write checkpoint failed')
	const activated = await store.checkpoint(started.id, written.version, 'source_bundle_written', 'source_activated', {
		appId: '123',
		appSlug: 'fabrika-source',
		appHtmlUrl: 'https://github.com/apps/fabrika-source',
	})
	if (activated === null) throw new Error('source activation checkpoint failed')
	const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(started.id), 'webhook-value')
	const webhookStored = await store.storeSecretAndCheckpoint(
		started.id,
		activated.version,
		'source_activated',
		'webhook_secret_stored',
		'webhook',
		webhook,
	)
	if (webhookStored === null) throw new Error('webhook checkpoint failed')
	const webhookConfigured = await store.checkpoint(started.id, webhookStored.version, 'webhook_secret_stored', 'webhook_configured')
	if (webhookConfigured === null) throw new Error('webhook config checkpoint failed')
	const verified = await store.checkpoint(started.id, webhookConfigured.version, 'webhook_configured', 'configuration_verified')
	if (verified === null) throw new Error('verification checkpoint failed')
	return { ...harness, store, vault, started, claimed, recovery, webhook, verified }
}

describe('GitHubConnectionStore', () => {
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
		expect(await store.getState()).toEqual({ state: 'anonymous' })
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
		expect(await store.getState()).toEqual({ state: 'anonymous' })
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
		expect(await store.getState()).toMatchObject({ state: 'setup_pending', phase: 'exchange_claimed' })
		clock = 110
		expect(await store.getState()).toEqual({ state: 'anonymous' })
		expect(await store.getAttempt('claimed')).toMatchObject({ status: 'failed', phase: 'exchange_claimed' })
	})

	test('turns a crashed durable manifest or adoption phase into repair after its lease', async () => {
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
		const recovery = await vault.prepareSecret('platform', githubRecoverySecretLabel('manifest-crash'), 'bundle')
		const recovered = await store.storeSecretAndCheckpoint(
			'manifest-crash',
			claimed.version,
			'exchange_claimed',
			'recovery_stored',
			'recovery',
			recovery,
		)
		if (recovered === null) throw new Error('recovery failed')
		clock = 110
		expect(await store.getState()).toMatchObject({ state: 'repair_required', attemptId: 'manifest-crash', phase: 'recovery_stored' })

		const { d1: adoptionDb } = createHarness(() => clock)
		const adoption = new GitHubConnectionStore(adoptionDb, () => clock, 10)
		await adoption.beginAdoption({
			id: 'adoption-crash',
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			appId: '123',
			appSlug: 'source',
			appHtmlUrl: 'https://github.com/apps/source',
			appOwner: 'acme',
			appPublic: false,
			credentialSha256: CREDENTIAL_DIGEST,
			expiresAt: 120,
		})
		clock = 120
		expect(await adoption.getState()).toMatchObject({ state: 'repair_required', attemptId: 'adoption-crash', phase: 'source_activated' })

		let writtenClock = 100
		const { d1: writtenDb } = createHarness(() => writtenClock)
		const writtenStore = new GitHubConnectionStore(writtenDb, () => writtenClock, 10)
		const writtenVault = await Vault.create(writtenDb, testKey(), () => writtenClock)
		const writtenState = await writtenVault.prepareSecret('platform', githubManifestStateSecretLabel('written-crash'), 'opaque-state')
		await writtenStore.beginAttemptWithManifestState({
			id: 'written-crash',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 110,
		}, writtenState)
		const writtenClaim = await writtenStore.claimCallback(STATE_DIGEST, 'alice')
		if (writtenClaim === null) throw new Error('claim failed')
		const writtenRecovery = await writtenVault.prepareSecret('platform', githubRecoverySecretLabel('written-crash'), 'bundle')
		const writtenRecovered = await writtenStore.storeSecretAndCheckpoint(
			'written-crash',
			writtenClaim.version,
			'exchange_claimed',
			'recovery_stored',
			'recovery',
			writtenRecovery,
		)
		if (writtenRecovered === null) throw new Error('recovery failed')
		const written = await writtenStore.checkpoint(
			'written-crash',
			writtenRecovered.version,
			'recovery_stored',
			'source_bundle_written',
			{ credentialSha256: CREDENTIAL_DIGEST },
		)
		if (written === null) throw new Error('source checkpoint failed')
		writtenClock = 110
		expect(await writtenStore.getState()).toMatchObject({ state: 'repair_required', attemptId: 'written-crash', phase: 'source_bundle_written' })
	})

	test('reaps every post-activation checkpoint, including remote-call-before-checkpoint windows', async () => {
		for (const target of ['webhook_secret_stored', 'webhook_configured', 'configuration_verified']) {
			let clock = 100
			const { d1 } = createHarness(() => clock)
			const store = new GitHubConnectionStore(d1, () => clock, 10)
			const vault = await Vault.create(d1, testKey(), () => clock)
			let attempt = await store.beginAdoption({
				id: `crash-${target}`,
				initiatedBy: 'alice',
				expectedOrigin: 'https://control.example',
				appId: '123',
				appSlug: 'source',
				appHtmlUrl: 'https://github.com/apps/source',
				appOwner: 'acme',
				appPublic: false,
				credentialSha256: CREDENTIAL_DIGEST,
				expiresAt: 110,
			})
			const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(attempt.id), 'webhook')
			const stored = await store.storeSecretAndCheckpoint(
				attempt.id,
				attempt.version,
				'source_activated',
				'webhook_secret_stored',
				'webhook',
				webhook,
			)
			if (stored === null) throw new Error('webhook checkpoint failed')
			attempt = stored
			if (target === 'webhook_configured' || target === 'configuration_verified') {
				const configured = await store.checkpoint(attempt.id, attempt.version, 'webhook_secret_stored', 'webhook_configured')
				if (configured === null) throw new Error('webhook configuration checkpoint failed')
				attempt = configured
			}
			if (target === 'configuration_verified') {
				const verified = await store.checkpoint(attempt.id, attempt.version, 'webhook_configured', 'configuration_verified')
				if (verified === null) throw new Error('verification checkpoint failed')
				attempt = verified
			}
			clock = 110
			expect(await store.getState()).toMatchObject({ state: 'repair_required', attemptId: attempt.id, phase: target })
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
		const { repositories } = createHarness(() => clock)
		const store = repositories.githubConnections
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
		const started = await store.beginAttempt(input)
		await expect(store.beginAttempt({ ...input, id: 'b', stateHash: OTHER_STATE_DIGEST })).rejects.toThrow('could not be started')
		clock = 200
		expect(await store.claimCallback(STATE_DIGEST, 'alice')).toBeNull()
		const failed = await store.markFailed(started.id, started.version, 'callback_expired')
		expect(failed?.status).toBe('failed')
		expect(failed?.stateHash).toBeNull()
		await expect(store.beginAttempt({ ...input, id: 'b', stateHash: OTHER_STATE_DIGEST, expiresAt: 300 })).resolves.toMatchObject({ id: 'b' })
	})

	test('uses CAS transitions and commits a platform secret with its checkpoint', async () => {
		const flow = await configuredAttempt()
		expect(flow.verified.requestedRepositories).toEqual(['acme/a', 'acme/z'])
		expect(await flow.store.checkpoint(flow.started.id, flow.claimed.version, 'exchange_claimed', 'recovery_stored')).toBeNull()
		expect(
			await flow.vault.getSecretForPurpose(flow.recovery.ref, {
				scope: 'platform',
				label: githubRecoverySecretLabel(flow.started.id),
			}),
		).toBe('one-time-pem')
		await expect(flow.vault.getSecretForPurpose(flow.recovery.ref, {
			scope: 'platform',
			label: githubWebhookSecretLabel(flow.started.id),
		})).rejects.toThrow('purpose mismatch')
	})

	test('removes recovery before publishing and exposes only redacted state', async () => {
		const flow = await configuredAttempt()
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		await expect(flow.vault.getSecret(flow.recovery.ref)).rejects.toThrow()
		const installationState = await flow.store.getState()
		expect(installationState).toMatchObject({
			state: 'installation_required',
			attemptId: flow.started.id,
			installationUrl: 'https://github.com/apps/fabrika-source/installations/new',
		})
		expect(JSON.stringify(installationState)).not.toContain('vault:')
		const connection = await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		expect(connection?.appOwner).toBe('acme')
		const state = await flow.store.getState()
		expect(state.state).toBe('connected')
		const serialized = JSON.stringify(state)
		expect(serialized).not.toContain('vault:')
		expect(serialized).not.toContain(STATE_DIGEST)
		expect(serialized).not.toContain(CREDENTIAL_DIGEST)

		const provider = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault)
		expect(await provider.getSecret()).toBe('webhook-value')
	})

	test('keeps installation-required stable after the operation lease expires', async () => {
		let clock = 100
		const { d1 } = createHarness(() => clock)
		const store = new GitHubConnectionStore(d1, () => clock, 10)
		const vault = await Vault.create(d1, testKey(), () => clock)
		const adopted = await store.beginAdoption({
			id: 'installation-wait',
			initiatedBy: 'principal-1',
			expectedOrigin: 'https://control.example',
			appId: '123',
			appSlug: 'fabrika-source',
			appHtmlUrl: 'https://github.com/apps/fabrika-source',
			appOwner: 'acme',
			appPublic: false,
			credentialSha256: CREDENTIAL_DIGEST,
			expiresAt: 110,
		})
		const webhook = await vault.prepareSecret('platform', githubWebhookSecretLabel(adopted.id), 'webhook-value')
		const stored = await store.storeSecretAndCheckpoint(
			adopted.id,
			adopted.version,
			'source_activated',
			'webhook_secret_stored',
			'webhook',
			webhook,
		)
		if (stored === null) throw new Error('webhook checkpoint failed')
		const configured = await store.checkpoint(stored.id, stored.version, 'webhook_secret_stored', 'webhook_configured')
		if (configured === null) throw new Error('webhook configuration failed')
		const verified = await store.checkpoint(configured.id, configured.version, 'webhook_configured', 'configuration_verified')
		if (verified === null) throw new Error('configuration verification failed')
		const waiting = await store.checkpoint(verified.id, verified.version, 'configuration_verified', 'installation_required')
		if (waiting === null) throw new Error('installation checkpoint failed')

		clock = 1_000
		expect(await store.getState()).toMatchObject({ state: 'installation_required', attemptId: adopted.id })
		expect(await store.getAttempt(adopted.id)).toMatchObject({ status: 'active', phase: 'installation_required' })
	})

	test('rejects malformed durable state instead of guessing a phase', async () => {
		const { repositories, sqlite } = createHarness(() => 100)
		await repositories.githubConnections.beginAttempt({
			id: 'a',
			stateHash: STATE_DIGEST,
			initiatedBy: 'alice',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 200,
		})
		sqlite.exec('PRAGMA ignore_check_constraints = ON')
		sqlite.query(`UPDATE github_source_setup_attempts SET phase = 'made_up' WHERE id = 'a'`).run()
		await expect(repositories.githubConnections.getAttempt('a')).rejects.toThrow('invalid GitHub setup phase')
	})

	test('refuses to publish mismatched webhook, installation owner, or verified repository scope', async () => {
		const flow = await configuredAttempt()
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		const base: PublishGitHubConnectionInput = {
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
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
				'source_activated',
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
		const first = await vault.prepareSecret('platform', githubRecoverySecretLabel(started.id), 'first')
		const second = await vault.prepareSecret('platform', githubRecoverySecretLabel(started.id), 'second')
		const barrier = new TwoPartyBarrier()
		const left = new GitHubConnectionStore(new BarrierDatabase(harness.d1, barrier), () => 1_000)
		const right = new GitHubConnectionStore(new BarrierDatabase(harness.d1, barrier), () => 1_000)
		const outcomes = await Promise.allSettled([
			left.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'recovery_stored', 'recovery', first),
			right.storeSecretAndCheckpoint(started.id, claimed.version, 'exchange_claimed', 'recovery_stored', 'recovery', second),
		])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
		expect(queryRows(harness.sqlite, 'SELECT id FROM vault')).toHaveLength(1)
		expect((await harness.repositories.githubConnections.getAttempt(started.id))?.phase).toBe('recovery_stored')
	})

	test('a batch barrier gives exactly one connection-publish CAS winner', async () => {
		const flow = await configuredAttempt()
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		const barrier = new TwoPartyBarrier()
		const left = new GitHubConnectionStore(new BarrierDatabase(flow.d1, barrier), () => 1_000)
		const right = new GitHubConnectionStore(new BarrierDatabase(flow.d1, barrier), () => 1_000)
		const input: PublishGitHubConnectionInput = {
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
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

	test('recovery deletion requires the exact platform purpose', async () => {
		const flow = await configuredAttempt()
		const recoveryId = flow.recovery.ref.slice('vault:'.length)
		flow.sqlite.query(`UPDATE vault SET scope = 'app' WHERE id = ?`).run(recoveryId)
		expect(await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)).toBeNull()
		expect((await flow.store.getAttempt(flow.started.id))?.phase).toBe('configuration_verified')
		expect(queryRows(flow.sqlite, 'SELECT id FROM vault WHERE id = ?', recoveryId)).toHaveLength(1)

		const tampered = await configuredAttempt()
		tampered.sqlite.query(`UPDATE github_source_setup_attempts SET recovery_secret_ref = ? WHERE id = ?`).run(
			tampered.webhook.ref,
			tampered.started.id,
		)
		expect(await tampered.store.discardRecoveryAndCheckpoint(tampered.started.id, tampered.verified.version)).toBeNull()
		expect(queryRows(tampered.sqlite, 'SELECT id FROM vault')).toHaveLength(2)
	})

	test('connection publish requires the exact webhook platform purpose and rolls back', async () => {
		const flow = await configuredAttempt()
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		const webhookId = flow.webhook.ref.slice('vault:'.length)
		flow.sqlite.query(`UPDATE vault SET label = 'platform:github-source:other:webhook' WHERE id = ?`).run(webhookId)
		await expect(flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})).rejects.toBeInstanceOf(GitHubConnectionCasError)
		expect((await flow.store.getAttempt(flow.started.id))?.phase).toBe('installation_required')
		expect(await flow.store.getConnection()).toBeNull()
	})

	test('does not advance when encrypted recovery is missing', async () => {
		const flow = await configuredAttempt()
		await flow.vault.delete(flow.recovery.ref)
		expect(await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)).toBeNull()
		expect((await flow.store.getAttempt(flow.started.id))?.phase).toBe('configuration_verified')
	})

	test('requires repair state instead of hiding a durable recovery secret in a failed row', async () => {
		const flow = await configuredAttempt()
		expect(await flow.store.markFailed(flow.started.id, flow.verified.version, 'configuration_verification')).toBeNull()
		const repair = await flow.store.markRepairRequired(flow.started.id, flow.verified.version, 'configuration_verification')
		expect(repair?.status).toBe('repair_required')
		expect(repair?.recoverySecretRef).toBe(flow.recovery.ref)
	})

	test('dynamic provider honors caller cancellation without returning a secret', async () => {
		const flow = await configuredAttempt()
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		const controller = new AbortController()
		controller.abort()
		const provider = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault)
		await expect(provider.getSecret(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
	})

	test('switches webhook authority after structural verification and keeps it after publish', async () => {
		const flow = await configuredAttempt()
		const provider = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault)
		expect(await provider.getSecret()).toBe('webhook-value')
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		expect(await provider.getSecret()).toBe('webhook-value')
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		expect(await provider.getSecret()).toBe('webhook-value')
	})

	test('uses legacy webhook fallback only before a durable connection exists', async () => {
		const harness = createHarness(() => 1_000)
		let fallbackReads = 0
		const fallback = {
			getSecret: () => {
				fallbackReads += 1
				return Promise.resolve('legacy-secret')
			},
		}
		const emptyVault = await Vault.create(harness.d1, testKey())
		const empty = new GitHubConnectionWebhookSecretProvider(harness.repositories.githubConnections, emptyVault, fallback)
		expect(await empty.getSecret()).toBe('legacy-secret')
		expect(fallbackReads).toBe(1)

		const flow = await configuredAttempt()
		const ready = await flow.store.discardRecoveryAndCheckpoint(flow.started.id, flow.verified.version)
		if (ready === null) throw new Error('recovery discard failed')
		await flow.store.publishConnection({
			attemptId: flow.started.id,
			expectedVersion: ready.version,
			webhookUrl: 'https://control.example/webhooks/github',
			installationId: 45,
			installationAccountLogin: 'acme',
			installationSelection: 'selected',
			verifiedRepositories: ['acme/a', 'acme/z'],
			verifiedAt: 1_000,
		})
		await flow.vault.delete(flow.webhook.ref)
		const connected = new GitHubConnectionWebhookSecretProvider(flow.store, flow.vault, fallback)
		await expect(connected.getSecret()).rejects.toThrow('unresolvable vault ref')
		expect(fallbackReads).toBe(1)
	})
})
