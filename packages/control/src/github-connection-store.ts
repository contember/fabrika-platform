import {
	GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH,
} from '@fabrika/control-contract'
import type { SqlDatabase } from '@fabrika/platform'
import type { WebhookSecretProvider } from './repo-source'
import { uuidv7 } from './uuid'
import { type PreparedVaultSecret, type Vault, vaultRef } from './vault'

export type GitHubSetupStatus = 'active' | 'repair_required' | 'completed' | 'failed'
export type GitHubSourceTransportKind = 'keyed-v2'
export type GitHubSetupErrorCode =
	| 'callback_expired'
	| 'manifest_exchange'
	| 'credential_persistence'
	| 'credential_activation'
	| 'webhook_configuration'
	| 'configuration_verification'
	| 'installation_verification'
	| 'configuration_conflict'
export type GitHubSetupPhase =
	| 'awaiting_manifest_callback'
	| 'exchange_claimed'
	| 'recovery_stored'
	| 'source_bundle_written'
	| 'source_activated'
	| 'webhook_secret_stored'
	| 'webhook_configured'
	| 'configuration_verified'
	| 'installation_required'
	| 'connected'

export interface GitHubSetupAttempt {
	id: string
	status: GitHubSetupStatus
	phase: GitHubSetupPhase
	version: number
	stateHash: string | null
	manifestStateSecretRef: string | null
	initiatedBy: string
	expectedOrigin: string
	desiredOwner: string
	desiredAppName: string
	desiredPublic: boolean
	requestedRepositories: string[]
	appId: string | null
	appSlug: string | null
	appHtmlUrl: string | null
	credentialSha256: string | null
	recoverySecretRef: string | null
	webhookSecretRef: string | null
	lastErrorCode: GitHubSetupErrorCode | null
	createdAt: number
	updatedAt: number
	expiresAt: number
	terminalAt: number | null
}

export interface GitHubSourceConnection {
	connectionId: string
	transportKind: GitHubSourceTransportKind
	appId: string
	appSlug: string
	appHtmlUrl: string
	appOwner: string
	appName: string
	appPublic: boolean
	credentialSha256: string
	webhookUrl: string
	webhookSecretRef: string
	installationId: number
	installationAccountLogin: string
	installationSelection: 'all' | 'selected'
	verifiedRepositories: string[]
	requestedRepositories: string[]
	connectedBy: string
	connectedAt: number
	verifiedAt: number
	version: number
}

export interface GitHubWebhookSecretBinding {
	connectionId: string
	webhookSecretRef: string
}

/** Safe projection for authenticated state queries. It excludes capability hashes and vault refs. */
export type GitHubConnectionState =
	| { state: 'anonymous' }
	| { state: 'setup_pending'; attemptId: string; phase: GitHubSetupPhase; owner: string; appName: string; updatedAt: number }
	| {
		state: 'installation_required'
		attemptId: string
		appId: string
		appSlug: string
		appHtmlUrl: string
		appOwner: string
		appName: string
		appPublic: boolean
		installationUrl: string
	}
	| { state: 'repair_required'; attemptId: string; phase: GitHubSetupPhase; errorCode: GitHubSetupErrorCode | null; updatedAt: number }
	| {
		state: 'connected'
		connectionId: string
		appId: string
		appSlug: string
		appHtmlUrl: string
		appOwner: string
		appName: string
		appPublic: boolean
		installationId: number
		installationAccountLogin: string
		installationSelection: 'all' | 'selected'
		verifiedRepositories: string[]
		requestedRepositories: string[]
		verifiedAt: number
	}

interface GitHubSetupAttemptRow {
	id: string
	status: string
	phase: string
	version: number
	state_hash: string | null
	manifest_state_secret_ref: string | null
	initiated_by: string
	expected_origin: string
	desired_owner: string
	desired_app_name: string
	desired_public: number
	requested_repositories_json: string
	app_id: string | null
	app_slug: string | null
	app_html_url: string | null
	credential_sha256: string | null
	recovery_secret_ref: string | null
	webhook_secret_ref: string | null
	last_error_code: string | null
	created_at: number
	updated_at: number
	expires_at: number
	terminal_at: number | null
}

interface GitHubSourceConnectionRow {
	connection_id: string
	transport_kind: string
	app_id: string
	app_slug: string
	app_html_url: string
	app_owner: string
	app_name: string
	app_public: number
	credential_sha256: string
	webhook_url: string
	webhook_secret_ref: string
	installation_id: number
	installation_account_login: string
	installation_selection: string
	verified_repositories_json: string
	requested_repositories_json: string
	connected_by: string
	connected_at: number
	verified_at: number
	version: number
}

export interface GitHubSourceConnectionPageInput {
	readonly cursor?: string
	readonly limit?: number
}

export interface GitHubSourceConnectionPage {
	readonly items: readonly GitHubSourceConnection[]
	readonly nextCursor: string | null
}

export interface BeginGitHubSetupInput {
	id?: string
	stateHash: string
	initiatedBy: string
	expectedOrigin: string
	desiredOwner: string
	desiredAppName: string
	desiredPublic: boolean
	requestedRepositories: readonly string[]
	expiresAt: number
}

export interface GitHubSetupPatch {
	appId?: string
	appSlug?: string
	appHtmlUrl?: string
	credentialSha256?: string
	lastErrorCode?: GitHubSetupErrorCode
}

export interface PublishGitHubConnectionInput {
	attemptId: string
	expectedVersion: number
	webhookUrl: string
	installationId: number
	installationAccountLogin: string
	installationSelection: 'all' | 'selected'
	verifiedRepositories: readonly string[]
	verifiedAt: number
}

export type GitHubSetupSecretKind = 'recovery' | 'webhook'

export class GitHubConnectionCasError extends Error {
	constructor() {
		super('GitHub source connection state changed')
		this.name = 'GitHubConnectionCasError'
	}
}

const ACTIVE_PHASES: readonly GitHubSetupPhase[] = [
	'awaiting_manifest_callback',
	'exchange_claimed',
	'recovery_stored',
	'source_bundle_written',
	'source_activated',
	'webhook_secret_stored',
	'webhook_configured',
	'configuration_verified',
	'installation_required',
]

// Exceeds the bounded source activation/configuration sequence; crash recovery appears after this lease.
const DEFAULT_OPERATION_LEASE_SECONDS = 10 * 60

export function githubRecoverySecretLabel(attemptId: string): string {
	return `platform:github-source:${attemptId}:recovery`
}

export function githubManifestStateSecretLabel(attemptId: string): string {
	return `platform:github-source:${attemptId}:manifest-state`
}

export function githubWebhookSecretLabel(connectionId: string): string {
	return `platform:github-source:${connectionId}:webhook`
}

export class GitHubConnectionStore {
	constructor(
		private readonly db: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
		private readonly operationLeaseSeconds: number = DEFAULT_OPERATION_LEASE_SECONDS,
	) {
		if (!Number.isSafeInteger(operationLeaseSeconds) || operationLeaseSeconds <= 0 || operationLeaseSeconds > 24 * 60 * 60) {
			throw new Error('invalid GitHub setup operation lease')
		}
	}

	async beginAttempt(input: BeginGitHubSetupInput): Promise<GitHubSetupAttempt> {
		const id = input.id ?? uuidv7()
		const now = this.now()
		validateSha256(input.stateHash, 'state hash')
		validateNonEmpty(input.initiatedBy, 'principal')
		validateControlOrigin(input.expectedOrigin)
		validateGitHubOwner(input.desiredOwner)
		validateNonEmpty(input.desiredAppName, 'desired app name')
		if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new Error('invalid setup expiry')
		const repositories = canonicalRepositories(input.requestedRepositories)
		try {
			const row = await this.db.prepare(`INSERT INTO github_source_setup_attempts (
				id, status, phase, version, state_hash, initiated_by, expected_origin, desired_owner,
				desired_app_name, desired_public, requested_repositories_json, created_at, updated_at, expires_at
			) SELECT ?, 'active', 'awaiting_manifest_callback', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE NOT EXISTS (
				SELECT 1 FROM github_source_connections_keyed WHERE lower(app_owner) = lower(?)
			) RETURNING *`)
				.bind(
					id,
					input.stateHash,
					input.initiatedBy,
					input.expectedOrigin,
					input.desiredOwner,
					input.desiredAppName,
					input.desiredPublic ? 1 : 0,
					JSON.stringify(repositories),
					now,
					now,
					input.expiresAt,
					input.desiredOwner,
				)
				.first<GitHubSetupAttemptRow>()
			if (row === null) throw new Error('setup write did not return state')
			return decodeAttempt(row)
		} catch {
			throw new Error('GitHub source setup could not be started')
		}
	}

	/** Atomically persist an expiring attempt and its encrypted one-use manifest state. */
	async beginAttemptWithManifestState(input: BeginGitHubSetupInput, secret: PreparedVaultSecret): Promise<GitHubSetupAttempt> {
		const id = input.id ?? uuidv7()
		const now = this.now()
		validateSha256(input.stateHash, 'state hash')
		validateNonEmpty(input.initiatedBy, 'principal')
		validateControlOrigin(input.expectedOrigin)
		validateGitHubOwner(input.desiredOwner)
		validateNonEmpty(input.desiredAppName, 'desired app name')
		if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new Error('invalid setup expiry')
		const repositories = canonicalRepositories(input.requestedRepositories)
		if (
			secret.scope !== 'platform' || secret.label !== githubManifestStateSecretLabel(id) || secret.ref !== vaultRef(secret.id)
			|| secret.ciphertext === '' || secret.valueIv === '' || secret.wrappedDek === '' || secret.dekIv === ''
		) throw new Error('invalid GitHub manifest state secret')
		const attempt = this.db.prepare(`INSERT INTO github_source_setup_attempts (
			id, status, phase, version, state_hash, manifest_state_secret_ref, initiated_by, expected_origin, desired_owner,
			desired_app_name, desired_public, requested_repositories_json, created_at, updated_at, expires_at
		) SELECT ?, 'active', 'awaiting_manifest_callback', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM github_source_connections_keyed WHERE lower(app_owner) = lower(?)
		) RETURNING *`)
			.bind(
				id,
				input.stateHash,
				secret.ref,
				input.initiatedBy,
				input.expectedOrigin,
				input.desiredOwner,
				input.desiredAppName,
				input.desiredPublic ? 1 : 0,
				JSON.stringify(repositories),
				now,
				now,
				input.expiresAt,
				input.desiredOwner,
			)
		const vaultInsert = this.db.prepare(`INSERT INTO vault (id, scope, label, ciphertext, value_iv, wrapped_dek, dek_iv)
			SELECT ?, ?, ?, ?, ?, ?, ? FROM github_source_setup_attempts
			WHERE id = ? AND version = 1 AND status = 'active' AND phase = 'awaiting_manifest_callback'
				AND state_hash = ? AND manifest_state_secret_ref = ?
			UNION ALL SELECT ?, 'invalid', ?, ?, ?, ?, ? WHERE (
				SELECT COUNT(*) FROM github_source_setup_attempts
				WHERE id = ? AND version = 1 AND status = 'active' AND phase = 'awaiting_manifest_callback'
					AND state_hash = ? AND manifest_state_secret_ref = ?
			) <> 1 RETURNING id`)
			.bind(
				secret.id,
				secret.scope,
				secret.label,
				secret.ciphertext,
				secret.valueIv,
				secret.wrappedDek,
				secret.dekIv,
				id,
				input.stateHash,
				secret.ref,
				secret.id,
				secret.label,
				secret.ciphertext,
				secret.valueIv,
				secret.wrappedDek,
				secret.dekIv,
				id,
				input.stateHash,
				secret.ref,
			)
		try {
			const results = await this.db.batch<GitHubSetupAttemptRow>([attempt, vaultInsert])
			const row = results[0]?.results[0]
			if (results[0]?.results.length !== 1 || results[1]?.results.length !== 1 || row === undefined) throw new Error('invalid result')
			return decodeAttempt(row)
		} catch {
			throw new Error('GitHub source setup could not be started')
		}
	}

	async getAttempt(id: string): Promise<GitHubSetupAttempt | null> {
		const row = await this.db.prepare('SELECT * FROM github_source_setup_attempts WHERE id = ?').bind(id).first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	async getConnection(): Promise<GitHubSourceConnection | null> {
		const page = await this.listConnections({ limit: 1 })
		return page.items[0] ?? null
	}

	async getConnectionById(connectionId: string): Promise<GitHubSourceConnection | null> {
		validateConnectionId(connectionId)
		const row = await this.db.prepare('SELECT * FROM github_source_connections_keyed WHERE connection_id = ?')
			.bind(connectionId)
			.first<GitHubSourceConnectionRow>()
		return row === null ? null : decodeConnection(row)
	}

	/** Bind a stable row to a verified durable credential without changing its source slot or App identity. */
	async rebindCredential(
		connectionId: string,
		expectedVersion: number,
		expectedCredentialSha256: string,
		credentialSha256: string,
	): Promise<GitHubSourceConnection | null> {
		validateConnectionId(connectionId)
		validateSafePositive(expectedVersion, 'connection version')
		validateSha256(expectedCredentialSha256, 'expected credential digest')
		validateSha256(credentialSha256, 'credential digest')
		const row = await this.db.prepare(`UPDATE github_source_connections_keyed SET
			credential_sha256 = ?, version = version + 1
			WHERE connection_id = ? AND version = ? AND credential_sha256 = ? RETURNING *`)
			.bind(credentialSha256, connectionId, expectedVersion, expectedCredentialSha256)
			.first<GitHubSourceConnectionRow>()
		return row === null ? null : decodeConnection(row)
	}

	async getConnectionByOwner(owner: string): Promise<GitHubSourceConnection | null> {
		validateGitHubOwner(owner)
		const row = await this.db.prepare(
			`SELECT * FROM github_source_connections_keyed WHERE lower(app_owner) = lower(?) LIMIT 1`,
		).bind(owner).first<GitHubSourceConnectionRow>()
		return row === null ? null : decodeConnection(row)
	}

	async getConnectionByBinding(connectionId: string, installationId: number): Promise<GitHubSourceConnection | null> {
		validateConnectionId(connectionId)
		validateSafePositive(installationId, 'installation id')
		const row = await this.db.prepare(
			'SELECT * FROM github_source_connections_keyed WHERE connection_id = ? AND installation_id = ?',
		).bind(connectionId, installationId).first<GitHubSourceConnectionRow>()
		return row === null ? null : decodeConnection(row)
	}

	async listConnections(input: GitHubSourceConnectionPageInput = {}): Promise<GitHubSourceConnectionPage> {
		const limit = input.limit ?? GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE) {
			throw new Error('invalid GitHub source connection page size')
		}
		if (
			input.cursor !== undefined
			&& (input.cursor.length === 0 || input.cursor.length > GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH)
		) throw new Error('invalid GitHub source connection cursor')
		const statement = input.cursor === undefined
			? this.db.prepare('SELECT * FROM github_source_connections_keyed ORDER BY connection_id LIMIT ?').bind(limit + 1)
			: this.db.prepare('SELECT * FROM github_source_connections_keyed WHERE connection_id > ? ORDER BY connection_id LIMIT ?')
				.bind(input.cursor, limit + 1)
		const { results } = await statement.all<GitHubSourceConnectionRow>()
		const pageRows = results.slice(0, limit)
		return {
			items: pageRows.map(decodeConnection),
			nextCursor: results.length > limit ? pageRows[pageRows.length - 1]?.connection_id ?? null : null,
		}
	}

	async getWorkflowAttempt(): Promise<GitHubSetupAttempt | null> {
		await this.reapExpiredAttempt()
		const row = await this.db.prepare(
			`SELECT * FROM github_source_setup_attempts
			WHERE status IN ('active','repair_required') ORDER BY updated_at DESC LIMIT 1`,
		).first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	async getWebhookSecretBindingByConnectionId(connectionId: string): Promise<GitHubWebhookSecretBinding | null> {
		const connection = await this.getConnectionById(connectionId)
		if (connection !== null) {
			return { connectionId: connection.connectionId, webhookSecretRef: connection.webhookSecretRef }
		}
		const attempt = await this.getAttempt(connectionId)
		if (
			attempt === null || !['active', 'repair_required'].includes(attempt.status)
			|| attempt.webhookSecretRef === null
			|| !['webhook_configured', 'configuration_verified', 'installation_required'].includes(attempt.phase)
		) return null
		return { connectionId: attempt.id, webhookSecretRef: attempt.webhookSecretRef }
	}

	/** Convert an expired phase lease into a safe resumable or terminal state. */
	async reapExpiredAttempt(): Promise<GitHubSetupAttempt | null> {
		const now = this.now()
		const row = await this.db.prepare(`SELECT * FROM github_source_setup_attempts
			WHERE status = 'active' AND phase <> 'installation_required' AND expires_at <= ?
			ORDER BY updated_at ASC LIMIT 1`).bind(now).first<GitHubSetupAttemptRow>()
		if (row === null) return null
		const attempt = decodeAttempt(row)
		if (attempt.phase === 'awaiting_manifest_callback' && attempt.manifestStateSecretRef !== null) {
			return await this.expireManifestCallback(attempt, now)
		}
		if (attempt.recoverySecretRef === null) {
			return await this.markExpired(attempt, now, 'failed', 'callback_expired')
		}
		return await this.markExpired(attempt, now, 'repair_required', errorForExpiredPhase(attempt.phase))
	}

	async getState(): Promise<GitHubConnectionState> {
		await this.reapExpiredAttempt()
		const connection = await this.getConnection()
		if (connection !== null) {
			return {
				state: 'connected',
				connectionId: connection.connectionId,
				appId: connection.appId,
				appSlug: connection.appSlug,
				appHtmlUrl: connection.appHtmlUrl,
				appOwner: connection.appOwner,
				appName: connection.appName,
				appPublic: connection.appPublic,
				installationId: connection.installationId,
				installationAccountLogin: connection.installationAccountLogin,
				installationSelection: connection.installationSelection,
				verifiedRepositories: connection.verifiedRepositories,
				requestedRepositories: connection.requestedRepositories,
				verifiedAt: connection.verifiedAt,
			}
		}
		const row = await this.db.prepare(
			`SELECT * FROM github_source_setup_attempts WHERE status IN ('active','repair_required') ORDER BY updated_at DESC LIMIT 1`,
		).first<GitHubSetupAttemptRow>()
		if (row === null) return { state: 'anonymous' }
		const attempt = decodeAttempt(row)
		if (attempt.status === 'repair_required') {
			return {
				state: 'repair_required',
				attemptId: attempt.id,
				phase: attempt.phase,
				errorCode: attempt.lastErrorCode,
				updatedAt: attempt.updatedAt,
			}
		}
		if (attempt.phase === 'installation_required') {
			if (attempt.appId === null || attempt.appSlug === null || attempt.appHtmlUrl === null) {
				throw new Error('invalid installation-required GitHub setup state')
			}
			return {
				state: 'installation_required',
				attemptId: attempt.id,
				appId: attempt.appId,
				appSlug: attempt.appSlug,
				appHtmlUrl: attempt.appHtmlUrl,
				appOwner: attempt.desiredOwner,
				appName: attempt.desiredAppName,
				appPublic: attempt.desiredPublic,
				installationUrl: `${attempt.appHtmlUrl}/installations/new`,
			}
		}
		return {
			state: 'setup_pending',
			attemptId: attempt.id,
			phase: attempt.phase,
			owner: attempt.desiredOwner,
			appName: attempt.desiredAppName,
			updatedAt: attempt.updatedAt,
		}
	}

	async claimCallback(stateHash: string, principalId: string): Promise<GitHubSetupAttempt | null> {
		validateSha256(stateHash, 'state hash')
		const now = this.now()
		const existing = await this.db.prepare(`SELECT * FROM github_source_setup_attempts
			WHERE state_hash = ? AND initiated_by = ? AND status = 'active'
				AND phase = 'awaiting_manifest_callback' AND expires_at > ?`)
			.bind(stateHash, principalId, now)
			.first<GitHubSetupAttemptRow>()
		if (existing === null || existing.manifest_state_secret_ref === null) return null
		const attempt = decodeAttempt(existing)
		const ref = existing.manifest_state_secret_ref
		const vaultId = ref.slice('vault:'.length)
		const label = githubManifestStateSecretLabel(attempt.id)
		const claim = this.db.prepare(`UPDATE github_source_setup_attempts
			SET phase = 'exchange_claimed', state_hash = NULL, version = version + 1, updated_at = ?, expires_at = ?
			WHERE id = ? AND version = ? AND state_hash = ? AND manifest_state_secret_ref = ?
				AND initiated_by = ? AND status = 'active' AND phase = 'awaiting_manifest_callback' AND expires_at > ?
				AND EXISTS (SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?)
			RETURNING *`)
			.bind(now, this.leaseExpiresAt(), attempt.id, attempt.version, stateHash, ref, principalId, now, vaultId, label)
		const remove = this.db.prepare(`DELETE FROM vault WHERE id = ? AND scope = 'platform' AND label = ? AND EXISTS (
			SELECT 1 FROM github_source_setup_attempts WHERE id = ? AND version = ? AND status = 'active'
				AND phase = 'exchange_claimed' AND state_hash IS NULL AND manifest_state_secret_ref = ?
		) RETURNING id`).bind(vaultId, label, attempt.id, attempt.version + 1, ref)
		const clear = this.db.prepare(`UPDATE github_source_setup_attempts SET manifest_state_secret_ref = NULL
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'exchange_claimed'
				AND manifest_state_secret_ref = ? AND NOT EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING *`).bind(attempt.id, attempt.version + 1, ref, vaultId, label)
		const assertion = this.db.prepare(`INSERT INTO vault (id, scope, label, ciphertext, value_iv, wrapped_dek, dek_iv)
			SELECT 'invalid-manifest-claim', 'invalid', 'invalid', '', '', '', '' WHERE (
				SELECT COUNT(*) FROM github_source_setup_attempts WHERE id = ? AND version = ? AND status = 'active'
					AND phase = 'exchange_claimed' AND state_hash IS NULL AND manifest_state_secret_ref IS NULL
			) <> 1 RETURNING id`).bind(attempt.id, attempt.version + 1)
		try {
			const results = await this.db.batch<GitHubSetupAttemptRow>([claim, remove, clear, assertion])
			const row = results[2]?.results[0]
			if (
				results[0]?.results.length !== 1 || results[1]?.results.length !== 1 || results[2]?.results.length !== 1
				|| results[3]?.results.length !== 0 || row === undefined
			) return null
			return decodeAttempt(row)
		} catch {
			return null
		}
	}

	async renewManifestHandoff(
		id: string,
		expectedVersion: number,
		principalId: string,
		expectedOrigin: string,
		expiresAt: number,
	): Promise<GitHubSetupAttempt | null> {
		const now = this.now()
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('invalid manifest handoff expiry')
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			expires_at = ?, version = version + 1, updated_at = ?
			WHERE id = ? AND version = ? AND initiated_by = ? AND expected_origin = ?
				AND status = 'active' AND phase = 'awaiting_manifest_callback' AND expires_at > ?
				AND manifest_state_secret_ref IS NOT NULL AND EXISTS (
					SELECT 1 FROM vault WHERE id = substr(manifest_state_secret_ref, 7)
						AND scope = 'platform' AND label = ?
				) RETURNING *`)
			.bind(expiresAt, now, id, expectedVersion, principalId, expectedOrigin, now, githubManifestStateSecretLabel(id))
			.first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	async resumeRepair(id: string, expectedVersion: number): Promise<GitHubSetupAttempt | null> {
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = 'active', last_error_code = NULL, version = version + 1, updated_at = ?, expires_at = ?
			WHERE id = ? AND version = ? AND status = 'repair_required' AND recovery_secret_ref IS NOT NULL
			RETURNING *`).bind(this.now(), this.leaseExpiresAt(), id, expectedVersion).first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	async checkpoint(
		id: string,
		expectedVersion: number,
		expectedPhase: GitHubSetupPhase,
		nextPhase: GitHubSetupPhase,
		patch: GitHubSetupPatch = {},
	): Promise<GitHubSetupAttempt | null> {
		if (!canTransition(expectedPhase, nextPhase)) throw new Error('invalid GitHub setup transition')
		if (patch.credentialSha256 !== undefined) validateSha256(patch.credentialSha256, 'credential digest')
		if (nextPhase === 'source_bundle_written' && patch.credentialSha256 === undefined) {
			throw new Error('source bundle checkpoint requires a credential digest')
		}
		if (nextPhase === 'source_activated' && (patch.appId === undefined || patch.appSlug === undefined || patch.appHtmlUrl === undefined)) {
			throw new Error('source activation checkpoint requires verified App identity')
		}
		if (
			nextPhase === 'source_activated'
			&& (
				patch.appId === undefined || !/^[1-9][0-9]*$/.test(patch.appId)
				|| patch.appSlug === undefined || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(patch.appSlug)
				|| patch.appHtmlUrl !== `https://github.com/apps/${patch.appSlug}`
			)
		) throw new Error('source activation checkpoint requires verified App identity')
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			phase = ?, version = version + 1, updated_at = ?, expires_at = ?,
			app_id = COALESCE(?, app_id), app_slug = COALESCE(?, app_slug), app_html_url = COALESCE(?, app_html_url),
			credential_sha256 = COALESCE(?, credential_sha256), last_error_code = COALESCE(?, last_error_code)
			WHERE id = ? AND version = ? AND status = 'active' AND phase = ? RETURNING *`)
			.bind(
				nextPhase,
				this.now(),
				this.leaseExpiresAt(),
				patch.appId ?? null,
				patch.appSlug ?? null,
				patch.appHtmlUrl ?? null,
				patch.credentialSha256 ?? null,
				patch.lastErrorCode ?? null,
				id,
				expectedVersion,
				expectedPhase,
			)
			.first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	/** Commit ciphertext and the phase/ref checkpoint in one portable database transaction. */
	async storeSecretAndCheckpoint(
		id: string,
		expectedVersion: number,
		expectedPhase: GitHubSetupPhase,
		nextPhase: GitHubSetupPhase,
		kind: GitHubSetupSecretKind,
		secret: PreparedVaultSecret,
	): Promise<GitHubSetupAttempt | null> {
		if (
			!canTransition(expectedPhase, nextPhase) || secret.scope !== 'platform' || secret.label !== expectedSecretLabel(id, kind)
			|| secret.ref !== vaultRef(secret.id) || secret.ciphertext === '' || secret.valueIv === '' || secret.wrappedDek === '' || secret.dekIv === ''
		) {
			throw new Error('invalid GitHub setup secret checkpoint')
		}
		const refColumn = kind === 'recovery' ? 'recovery_secret_ref' : 'webhook_secret_ref'
		const update = this.db.prepare(`UPDATE github_source_setup_attempts SET
			phase = ?, ${refColumn} = ?, version = version + 1, updated_at = ?, expires_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = ? RETURNING *`)
			.bind(nextPhase, secret.ref, this.now(), this.leaseExpiresAt(), id, expectedVersion, expectedPhase)
		const insert = this.db.prepare(`INSERT INTO vault (id, scope, label, ciphertext, value_iv, wrapped_dek, dek_iv)
			SELECT ?, ?, ?, ?, ?, ?, ? FROM github_source_setup_attempts
			WHERE id = ? AND version = ? AND status = 'active' AND phase = ? AND ${refColumn} = ?
			UNION ALL
			SELECT ?, 'invalid', ?, ?, ?, ?, ? WHERE (
				SELECT COUNT(*) FROM github_source_setup_attempts
				WHERE id = ? AND version = ? AND status = 'active' AND phase = ? AND ${refColumn} = ?
			) <> 1
			RETURNING id`)
			.bind(
				secret.id,
				secret.scope,
				secret.label,
				secret.ciphertext,
				secret.valueIv,
				secret.wrappedDek,
				secret.dekIv,
				id,
				expectedVersion + 1,
				nextPhase,
				secret.ref,
				secret.id,
				secret.label,
				secret.ciphertext,
				secret.valueIv,
				secret.wrappedDek,
				secret.dekIv,
				id,
				expectedVersion + 1,
				nextPhase,
				secret.ref,
			)
		const results = await this.db.batch<GitHubSetupAttemptRow>([update, insert]).catch(() => {
			throw new GitHubConnectionCasError()
		})
		const row = results[0]?.results[0]
		if (results[0]?.results.length !== 1 || results[1]?.results.length !== 1 || row === undefined) throw new GitHubConnectionCasError()
		return decodeAttempt(row)
	}

	async markRepairRequired(id: string, expectedVersion: number, errorCode: GitHubSetupErrorCode): Promise<GitHubSetupAttempt | null> {
		return this.markTerminalLike(id, expectedVersion, 'repair_required', errorCode, false)
	}

	/** Delete one-time recovery material with the durable installation-required checkpoint. */
	async discardRecoveryAndCheckpoint(id: string, expectedVersion: number): Promise<GitHubSetupAttempt | null> {
		const attempt = await this.getAttempt(id)
		if (
			attempt === null || attempt.version !== expectedVersion || attempt.status !== 'active'
			|| attempt.phase !== 'configuration_verified' || attempt.recoverySecretRef === null
		) return null
		const vaultId = attempt.recoverySecretRef.slice('vault:'.length)
		const recoveryLabel = githubRecoverySecretLabel(id)
		const advance = this.db.prepare(`UPDATE github_source_setup_attempts SET
			phase = 'installation_required', version = version + 1, updated_at = ?, expires_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'configuration_verified'
				AND recovery_secret_ref = ? AND EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING id`)
			.bind(this.now(), this.leaseExpiresAt(), id, expectedVersion, attempt.recoverySecretRef, vaultId, recoveryLabel)
		const remove = this.db.prepare(`DELETE FROM vault WHERE id = ? AND scope = 'platform' AND label = ? AND EXISTS (
			SELECT 1 FROM github_source_setup_attempts
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'installation_required'
				AND recovery_secret_ref = ?
		) RETURNING id`).bind(vaultId, recoveryLabel, id, expectedVersion + 1, attempt.recoverySecretRef)
		const clear = this.db.prepare(`UPDATE github_source_setup_attempts SET recovery_secret_ref = NULL
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'installation_required'
				AND recovery_secret_ref = ? AND NOT EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING *`)
			.bind(id, expectedVersion + 1, attempt.recoverySecretRef, vaultId, recoveryLabel)
		const results = await this.db.batch<GitHubSetupAttemptRow>([advance, remove, clear])
		if (results[0]?.results.length !== 1 || results[1]?.results.length !== 1 || results[2]?.results.length !== 1) return null
		const row = results[2]?.results[0]
		return row === undefined ? null : decodeAttempt(row)
	}

	async markFailed(id: string, expectedVersion: number, errorCode: GitHubSetupErrorCode): Promise<GitHubSetupAttempt | null> {
		return this.markTerminalLike(id, expectedVersion, 'failed', errorCode, true)
	}

	async publishConnection(input: PublishGitHubConnectionInput): Promise<GitHubSourceConnection | null> {
		if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) throw new Error('invalid installation id')
		validateNonEmpty(input.installationAccountLogin, 'installation account')
		const verifiedRepositories = canonicalRepositories(input.verifiedRepositories)
		const attempt = await this.getAttempt(input.attemptId)
		if (
			attempt === null || attempt.version !== input.expectedVersion || attempt.status !== 'active' || attempt.phase !== 'installation_required'
			|| attempt.appId === null || attempt.appSlug === null || attempt.appHtmlUrl === null || attempt.credentialSha256 === null
			|| attempt.webhookSecretRef === null || input.installationAccountLogin.toLowerCase() !== attempt.desiredOwner.toLowerCase()
			|| JSON.stringify(verifiedRepositories) !== JSON.stringify(attempt.requestedRepositories)
			|| input.webhookUrl !== `${attempt.expectedOrigin}/webhooks/github/${encodeURIComponent(attempt.id)}`
		) return null
		const webhookVaultId = attempt.webhookSecretRef.slice('vault:'.length)
		const webhookLabel = githubWebhookSecretLabel(input.attemptId)
		const terminalAt = this.now()
		const attemptUpdate = this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = 'completed', phase = 'connected', state_hash = NULL, recovery_secret_ref = NULL,
			version = version + 1, updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'installation_required'
				AND webhook_secret_ref = ? AND EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING *`)
			.bind(terminalAt, terminalAt, input.attemptId, input.expectedVersion, attempt.webhookSecretRef, webhookVaultId, webhookLabel)
		const connectionInsert = this.db.prepare(`INSERT INTO github_source_connections_keyed (
			connection_id, transport_kind, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
			credential_sha256, webhook_url, webhook_secret_ref, installation_id,
			installation_account_login, installation_selection, verified_repositories_json,
			requested_repositories_json, connected_by, connected_at, verified_at, version
		) SELECT id, 'keyed-v2',
			app_id, app_slug, app_html_url, desired_owner, desired_app_name, desired_public,
			credential_sha256, ?, webhook_secret_ref, ?, ?, ?, ?, requested_repositories_json,
			initiated_by, ?, ?, 1 FROM github_source_setup_attempts
			WHERE id = ? AND version = ? AND status = 'completed' AND phase = 'connected'
				AND app_id IS NOT NULL AND app_slug IS NOT NULL AND app_html_url IS NOT NULL
				AND credential_sha256 IS NOT NULL AND webhook_secret_ref = ?
				AND EXISTS (SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?)
			UNION ALL SELECT
				'invalid', 'invalid', '1', 'invalid', 'https://github.com/apps/invalid', 'invalid', 'invalid', 0,
				'0000000000000000000000000000000000000000000000000000000000000000',
				'https://invalid.example/webhooks/github', 'vault:invalid', 1, 'invalid', 'selected', '[]', '[]', 'invalid', 0, 0, 1
			WHERE (
				SELECT COUNT(*) FROM github_source_setup_attempts
				WHERE id = ? AND version = ? AND status = 'completed' AND phase = 'connected'
					AND webhook_secret_ref = ?
					AND EXISTS (SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?)
			) <> 1
			RETURNING *`)
			.bind(
				input.webhookUrl,
				input.installationId,
				input.installationAccountLogin,
				input.installationSelection,
				JSON.stringify(verifiedRepositories),
				this.now(),
				input.verifiedAt,
				input.attemptId,
				input.expectedVersion + 1,
				attempt.webhookSecretRef,
				webhookVaultId,
				webhookLabel,
				input.attemptId,
				input.expectedVersion + 1,
				attempt.webhookSecretRef,
				webhookVaultId,
				webhookLabel,
			)
		const results = await this.db.batch<GitHubSourceConnectionRow>([attemptUpdate, connectionInsert]).catch(() => {
			throw new GitHubConnectionCasError()
		})
		const row = results[1]?.results[0]
		if (results[0]?.results.length !== 1 || results[1]?.results.length !== 1 || row === undefined) throw new GitHubConnectionCasError()
		return decodeConnection(row)
	}

	private async markTerminalLike(
		id: string,
		expectedVersion: number,
		status: 'repair_required' | 'failed',
		errorCode: GitHubSetupErrorCode,
		terminal: boolean,
	): Promise<GitHubSetupAttempt | null> {
		const now = this.now()
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = ?, state_hash = NULL, last_error_code = ?, version = version + 1,
			updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active'
				AND (? = 'repair_required' OR recovery_secret_ref IS NULL) RETURNING *`)
			.bind(status, errorCode, now, terminal ? now : null, id, expectedVersion, status)
			.first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	private leaseExpiresAt(): number {
		return this.now() + this.operationLeaseSeconds
	}

	private async markExpired(
		attempt: GitHubSetupAttempt,
		now: number,
		status: 'repair_required' | 'failed',
		errorCode: GitHubSetupErrorCode,
	): Promise<GitHubSetupAttempt | null> {
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = ?, state_hash = NULL, last_error_code = ?, version = version + 1,
			updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND expires_at <= ? RETURNING *`)
			.bind(status, errorCode, now, status === 'failed' ? now : null, attempt.id, attempt.version, now)
			.first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}

	private async expireManifestCallback(attempt: GitHubSetupAttempt, now: number): Promise<GitHubSetupAttempt | null> {
		if (attempt.manifestStateSecretRef === null) return null
		const ref = attempt.manifestStateSecretRef
		const vaultId = ref.slice('vault:'.length)
		const label = githubManifestStateSecretLabel(attempt.id)
		const expire = this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = 'failed', state_hash = NULL, last_error_code = 'callback_expired', version = version + 1,
			updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'awaiting_manifest_callback'
				AND expires_at <= ? AND manifest_state_secret_ref = ?
				AND EXISTS (SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?)
			RETURNING id`).bind(now, now, attempt.id, attempt.version, now, ref, vaultId, label)
		const remove = this.db.prepare(`DELETE FROM vault WHERE id = ? AND scope = 'platform' AND label = ? AND EXISTS (
			SELECT 1 FROM github_source_setup_attempts WHERE id = ? AND version = ? AND status = 'failed'
				AND phase = 'awaiting_manifest_callback' AND manifest_state_secret_ref = ?
		) RETURNING id`).bind(vaultId, label, attempt.id, attempt.version + 1, ref)
		const clear = this.db.prepare(`UPDATE github_source_setup_attempts SET manifest_state_secret_ref = NULL
			WHERE id = ? AND version = ? AND status = 'failed' AND phase = 'awaiting_manifest_callback'
				AND manifest_state_secret_ref = ? AND NOT EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING *`).bind(attempt.id, attempt.version + 1, ref, vaultId, label)
		try {
			const results = await this.db.batch<GitHubSetupAttemptRow>([expire, remove, clear])
			const expired = results[2]?.results[0]
			if (results[0]?.results.length !== 1 || results[1]?.results.length !== 1 || results[2]?.results.length !== 1 || expired === undefined) {
				return await this.expireManifestCallbackWithoutResolvableSecret(attempt, now, vaultId, label)
			}
			return decodeAttempt(expired)
		} catch {
			return await this.expireManifestCallbackWithoutResolvableSecret(attempt, now, vaultId, label)
		}
	}

	private async expireManifestCallbackWithoutResolvableSecret(
		attempt: GitHubSetupAttempt,
		now: number,
		vaultId: string,
		label: string,
	): Promise<GitHubSetupAttempt | null> {
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = 'failed', state_hash = NULL, manifest_state_secret_ref = NULL,
			last_error_code = 'callback_expired', version = version + 1, updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'awaiting_manifest_callback'
				AND expires_at <= ? AND manifest_state_secret_ref = ? AND NOT EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING *`)
			.bind(now, now, attempt.id, attempt.version, now, attempt.manifestStateSecretRef, vaultId, label)
			.first<GitHubSetupAttemptRow>()
		return row === null ? null : decodeAttempt(row)
	}
}

/** Reads the named connection on every delivery, so rotation takes effect without a restart. */
export class GitHubConnectionWebhookSecretProvider implements WebhookSecretProvider {
	constructor(
		private readonly store: GitHubConnectionStore,
		private readonly vault: Vault | (() => Promise<Vault>),
		private readonly connectionId: string,
	) {}

	async getSecret(signal?: AbortSignal): Promise<string | null> {
		throwIfAborted(signal)
		const binding = await this.store.getWebhookSecretBindingByConnectionId(this.connectionId)
		throwIfAborted(signal)
		if (binding === null) return null
		const secretVault = typeof this.vault === 'function' ? await this.vault() : this.vault
		const secret = await secretVault.getSecretForPurpose(binding.webhookSecretRef, {
			scope: 'platform',
			label: githubWebhookSecretLabel(binding.connectionId),
		})
		throwIfAborted(signal)
		return secret
	}
}

function decodeAttempt(row: GitHubSetupAttemptRow): GitHubSetupAttempt {
	const status = parseStatus(row.status)
	const phase = parsePhase(row.phase)
	validateSafePositive(row.version, 'attempt version')
	validateSafeNonNegative(row.created_at, 'created timestamp')
	validateSafeNonNegative(row.updated_at, 'updated timestamp')
	validateSafeNonNegative(row.expires_at, 'expiry timestamp')
	if (row.terminal_at !== null) validateSafeNonNegative(row.terminal_at, 'terminal timestamp')
	if ((status === 'completed' || status === 'failed') !== (row.terminal_at !== null)) throw new Error('invalid GitHub setup terminal state')
	if ((status === 'completed') !== (phase === 'connected')) throw new Error('invalid completed GitHub setup phase')
	if ((status === 'active' && phase === 'awaiting_manifest_callback') !== (row.state_hash !== null)) {
		throw new Error('invalid GitHub setup capability state')
	}
	if (status === 'active' && !ACTIVE_PHASES.includes(phase)) throw new Error('invalid active GitHub setup phase')
	validatePhaseFields(row, phase)
	return {
		id: required(row.id, 'attempt id'),
		status,
		phase,
		version: row.version,
		stateHash: optionalSha256(row.state_hash, 'state hash'),
		manifestStateSecretRef: optionalVaultRef(row.manifest_state_secret_ref),
		initiatedBy: required(row.initiated_by, 'initiating principal'),
		expectedOrigin: required(row.expected_origin, 'expected origin'),
		desiredOwner: required(row.desired_owner, 'desired owner'),
		desiredAppName: required(row.desired_app_name, 'desired app name'),
		desiredPublic: parseBoolean(row.desired_public, 'desired public'),
		requestedRepositories: parseRepositories(row.requested_repositories_json),
		appId: optionalNonEmpty(row.app_id, 'app id'),
		appSlug: optionalNonEmpty(row.app_slug, 'app slug'),
		appHtmlUrl: optionalNonEmpty(row.app_html_url, 'app HTML URL'),
		credentialSha256: optionalSha256(row.credential_sha256, 'credential digest'),
		recoverySecretRef: optionalVaultRef(row.recovery_secret_ref),
		webhookSecretRef: optionalVaultRef(row.webhook_secret_ref),
		lastErrorCode: parseOptionalErrorCode(row.last_error_code),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		terminalAt: row.terminal_at,
	}
}

function validatePhaseFields(row: GitHubSetupAttemptRow, phase: GitHubSetupPhase): void {
	const sourceWritten = phaseIndex(phase) >= phaseIndex('source_bundle_written')
	const sourceActivated = phaseIndex(phase) >= phaseIndex('source_activated')
	const webhookStored = phaseIndex(phase) >= phaseIndex('webhook_secret_stored')
	const recoveryExpected = phaseIndex(phase) >= phaseIndex('recovery_stored') && phaseIndex(phase) < phaseIndex('installation_required')
	if (sourceWritten && row.credential_sha256 === null) throw new Error('invalid GitHub setup credential state')
	if (sourceActivated && (row.app_id === null || row.app_slug === null || row.app_html_url === null)) {
		throw new Error('invalid GitHub setup App state')
	}
	if (sourceActivated) {
		if (row.app_id === null || !/^[1-9][0-9]*$/.test(row.app_id)) throw new Error('invalid GitHub setup App id')
		if (row.app_slug === null || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(row.app_slug)) {
			throw new Error('invalid GitHub setup App slug')
		}
		if (row.app_html_url !== `https://github.com/apps/${row.app_slug}`) throw new Error('invalid GitHub setup App URL')
	}
	if (recoveryExpected !== (row.recovery_secret_ref !== null)) throw new Error('invalid GitHub setup recovery state')
	if (webhookStored !== (row.webhook_secret_ref !== null)) throw new Error('invalid GitHub setup webhook state')
}

function phaseIndex(phase: GitHubSetupPhase): number {
	const phases: readonly GitHubSetupPhase[] = [
		'awaiting_manifest_callback',
		'exchange_claimed',
		'recovery_stored',
		'source_bundle_written',
		'source_activated',
		'webhook_secret_stored',
		'webhook_configured',
		'configuration_verified',
		'installation_required',
		'connected',
	]
	return phases.indexOf(phase)
}

function decodeConnection(row: GitHubSourceConnectionRow): GitHubSourceConnection {
	validateSafePositive(row.version, 'connection version')
	validateSafePositive(row.installation_id, 'installation id')
	validateSafeNonNegative(row.connected_at, 'connected timestamp')
	validateSafeNonNegative(row.verified_at, 'verified timestamp')
	return {
		connectionId: required(row.connection_id, 'connection id'),
		transportKind: parseTransportKind(row.transport_kind),
		appId: required(row.app_id, 'app id'),
		appSlug: required(row.app_slug, 'app slug'),
		appHtmlUrl: required(row.app_html_url, 'app HTML URL'),
		appOwner: required(row.app_owner, 'app owner'),
		appName: required(row.app_name, 'app name'),
		appPublic: parseBoolean(row.app_public, 'app public'),
		credentialSha256: requiredSha256(row.credential_sha256, 'credential digest'),
		webhookUrl: required(row.webhook_url, 'webhook URL'),
		webhookSecretRef: requiredVaultRef(row.webhook_secret_ref),
		installationId: row.installation_id,
		installationAccountLogin: required(row.installation_account_login, 'installation account'),
		installationSelection: parseInstallationSelection(row.installation_selection),
		verifiedRepositories: parseRepositories(row.verified_repositories_json),
		requestedRepositories: parseRepositories(row.requested_repositories_json),
		connectedBy: required(row.connected_by, 'connected principal'),
		connectedAt: row.connected_at,
		verifiedAt: row.verified_at,
		version: row.version,
	}
}

function parseTransportKind(value: string): GitHubSourceTransportKind {
	if (value === 'keyed-v2') return value
	throw new Error('invalid GitHub source transport kind')
}

function parseStatus(value: string): GitHubSetupStatus {
	if (value === 'active' || value === 'repair_required' || value === 'completed' || value === 'failed') return value
	throw new Error('invalid GitHub setup status')
}

function parseInstallationSelection(value: string): 'all' | 'selected' {
	if (value === 'all' || value === 'selected') return value
	throw new Error('invalid GitHub installation selection')
}

function parsePhase(value: string): GitHubSetupPhase {
	if (
		value === 'awaiting_manifest_callback' || value === 'exchange_claimed' || value === 'recovery_stored' || value === 'source_bundle_written'
		|| value === 'source_activated' || value === 'webhook_secret_stored' || value === 'webhook_configured'
		|| value === 'configuration_verified' || value === 'installation_required' || value === 'connected'
	) return value
	throw new Error('invalid GitHub setup phase')
}

function canTransition(current: GitHubSetupPhase, next: GitHubSetupPhase): boolean {
	if (current === 'exchange_claimed') return next === 'recovery_stored'
	if (current === 'recovery_stored') return next === 'source_bundle_written'
	if (current === 'source_bundle_written') return next === 'source_activated'
	if (current === 'source_activated') return next === 'webhook_secret_stored'
	if (current === 'webhook_secret_stored') return next === 'webhook_configured'
	if (current === 'webhook_configured') return next === 'configuration_verified'
	if (current === 'configuration_verified') return next === 'installation_required'
	return false
}

function canonicalRepositories(values: readonly string[]): string[] {
	const unique = new Set<string>()
	for (const value of values) {
		const [owner, name, ...rest] = value.split('/')
		if (owner === undefined || name === undefined || rest.length !== 0) throw new Error('invalid GitHub setup repository')
		validateGitHubOwner(owner)
		if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('invalid GitHub setup repository')
		unique.add(`${owner.toLowerCase()}/${name.toLowerCase()}`)
	}
	return [...unique].sort()
}

function parseRepositories(json: string): string[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		throw new Error('invalid GitHub setup repository state')
	}
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string' && value !== '')) {
		throw new Error('invalid GitHub setup repository state')
	}
	const repositories: string[] = []
	for (const value of parsed) {
		if (typeof value !== 'string') throw new Error('invalid GitHub setup repository state')
		repositories.push(value)
	}
	if (JSON.stringify(canonicalRepositories(repositories)) !== JSON.stringify(repositories)) {
		throw new Error('non-canonical GitHub setup repository state')
	}
	return repositories
}

function required(value: string, field: string): string {
	validateNonEmpty(value, field)
	return value
}

function validateNonEmpty(value: string, field: string): void {
	if (value.trim() === '') throw new Error(`invalid GitHub setup ${field}`)
}

function validateControlOrigin(value: string): void {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('invalid GitHub setup expected origin')
	}
	if (url.protocol !== 'https:' || url.origin !== value || url.username !== '' || url.password !== '') {
		throw new Error('invalid GitHub setup expected origin')
	}
}

function validateGitHubOwner(value: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) throw new Error('invalid GitHub setup owner')
}

function validateConnectionId(value: string): void {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('invalid GitHub setup connection id')
}

function optionalNonEmpty(value: string | null, field: string): string | null {
	if (value === null) return null
	return required(value, field)
}

function optionalSha256(value: string | null, field: string): string | null {
	if (value === null) return null
	return requiredSha256(value, field)
}

function requiredSha256(value: string, field: string): string {
	validateSha256(value, field)
	return value
}

function validateSha256(value: string, field: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid GitHub setup ${field}`)
}

function optionalVaultRef(value: string | null): string | null {
	if (value === null) return null
	return requiredVaultRef(value)
}

function requiredVaultRef(value: string): string {
	if (!value.startsWith('vault:') || value.length === 'vault:'.length) throw new Error('invalid GitHub setup vault ref')
	return value
}

function parseBoolean(value: number, field: string): boolean {
	if (value === 0) return false
	if (value === 1) return true
	throw new Error(`invalid GitHub setup ${field}`)
}

function validateSafePositive(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid GitHub setup ${field}`)
}

function validateSafeNonNegative(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid GitHub setup ${field}`)
}

function parseOptionalErrorCode(value: string | null): GitHubSetupErrorCode | null {
	if (value === null) return null
	if (
		value === 'callback_expired' || value === 'manifest_exchange' || value === 'credential_persistence'
		|| value === 'credential_activation' || value === 'webhook_configuration' || value === 'configuration_verification'
		|| value === 'installation_verification' || value === 'configuration_conflict'
	) return value
	throw new Error('invalid GitHub setup error code')
}

function expectedSecretLabel(id: string, kind: GitHubSetupSecretKind): string {
	return kind === 'recovery' ? githubRecoverySecretLabel(id) : githubWebhookSecretLabel(id)
}

function errorForExpiredPhase(phase: GitHubSetupPhase): GitHubSetupErrorCode {
	if (phase === 'recovery_stored' || phase === 'source_bundle_written') return 'credential_activation'
	if (phase === 'source_activated') return 'credential_persistence'
	if (phase === 'webhook_secret_stored' || phase === 'webhook_configured') return 'webhook_configuration'
	if (phase === 'installation_required') return 'installation_verification'
	return 'configuration_verification'
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
}
