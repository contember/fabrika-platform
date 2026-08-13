import type { SqlDatabase, SqlQueryResult, SqlStatement } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import {
	GitHubConnectionCasError,
	GitHubConnectionStore,
	GitHubConnectionWebhookSecretProvider,
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
	const started = await store.beginAttempt({
		id: 'attempt-1',
		stateHash: STATE_DIGEST,
		initiatedBy: 'principal-1',
		expectedOrigin: 'https://control.example',
		desiredOwner: 'acme',
		desiredAppName: 'fabrika-source',
		desiredPublic: false,
		requestedRepositories: ['acme/z', 'acme/a', 'acme/a'],
		expiresAt: 2_000,
	})
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
	test('claims a callback once and binds it to the initiating principal', async () => {
		const { repositories } = createHarness(() => 100)
		const store = repositories.githubConnections
		await store.beginAttempt({
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
		const started = await harness.repositories.githubConnections.beginAttempt({
			id: 'contended-attempt',
			stateHash: STATE_DIGEST,
			initiatedBy: 'principal-1',
			expectedOrigin: 'https://control.example',
			desiredOwner: 'acme',
			desiredAppName: 'source',
			desiredPublic: false,
			requestedRepositories: [],
			expiresAt: 2_000,
		})
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
})
