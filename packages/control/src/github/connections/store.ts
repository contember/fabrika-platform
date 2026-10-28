import {
	GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH,
} from '@fabrika/control-contract'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { type PreparedVaultSecret, vaultRef } from '../../vault'
import {
	canonicalRepositories,
	canTransition,
	decodeAttempt,
	decodeConnection,
	validateConnectionId,
	validateControlOrigin,
	validateGitHubOwner,
	validateNonEmpty,
	validateSafePositive,
	validateSha256,
} from './decoding'
import {
	type BeginGitHubSetupInput,
	GitHubConnectionCasError,
	type GitHubSetupAttempt,
	type GitHubSetupAttemptRow,
	type GitHubSetupErrorCode,
	type GitHubSetupPatch,
	type GitHubSetupPhase,
	type GitHubSetupSecretKind,
	type GitHubSourceConnection,
	type GitHubSourceConnectionPage,
	type GitHubSourceConnectionPageInput,
	type GitHubSourceConnectionRow,
	type GitHubWebhookSecretBinding,
	type PublishGitHubConnectionInput,
} from './model'
import { githubAppCredentialSecretLabel, githubManifestStateSecretLabel, githubWebhookSecretLabel } from './secrets'

// Exceeds the bounded App verification and webhook configuration sequence; crash recovery appears after this lease.
const DEFAULT_OPERATION_LEASE_SECONDS = 10 * 60

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

	async getConnectionById(connectionId: string): Promise<GitHubSourceConnection | null> {
		validateConnectionId(connectionId)
		const row = await this.db.prepare('SELECT * FROM github_source_connections_keyed WHERE connection_id = ?')
			.bind(connectionId)
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
			|| !['webhook_configured', 'installation_required'].includes(attempt.phase)
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
		if (attempt.appCredentialRef === null) {
			return await this.markExpired(attempt, now, 'failed', 'callback_expired')
		}
		return await this.markExpired(attempt, now, 'repair_required', errorForExpiredPhase(attempt.phase))
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
			WHERE id = ? AND version = ? AND status = 'repair_required' AND app_credential_ref IS NOT NULL
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
		if (
			nextPhase === 'app_verified'
			&& (
				patch.appId === undefined || !/^[1-9][0-9]*$/.test(patch.appId)
				|| patch.appSlug === undefined || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(patch.appSlug)
				|| patch.appHtmlUrl !== `https://github.com/apps/${patch.appSlug}`
			)
		) throw new Error('App verification checkpoint requires verified App identity')
		const row = await this.db.prepare(`UPDATE github_source_setup_attempts SET
			phase = ?, version = version + 1, updated_at = ?, expires_at = ?,
			app_id = COALESCE(?, app_id), app_slug = COALESCE(?, app_slug), app_html_url = COALESCE(?, app_html_url),
			last_error_code = COALESCE(?, last_error_code)
			WHERE id = ? AND version = ? AND status = 'active' AND phase = ? RETURNING *`)
			.bind(
				nextPhase,
				this.now(),
				this.leaseExpiresAt(),
				patch.appId ?? null,
				patch.appSlug ?? null,
				patch.appHtmlUrl ?? null,
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
		const refColumn = kind === 'app-credential' ? 'app_credential_ref' : 'webhook_secret_ref'
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

	async markFailed(id: string, expectedVersion: number, errorCode: GitHubSetupErrorCode): Promise<GitHubSetupAttempt | null> {
		return this.markTerminalLike(id, expectedVersion, 'failed', errorCode, true)
	}

	/**
	 * Fail an attempt whose stored App can never be verified, and drop its key from the vault in the same batch. The
	 * attempt keeps the ref (its phase says a key was stored) to a key that no longer exists, and frees the one setup
	 * slot for a fresh connection.
	 */
	async failWithCredential(attempt: GitHubSetupAttempt, errorCode: GitHubSetupErrorCode): Promise<GitHubSetupAttempt | null> {
		if (attempt.appCredentialRef === null) return null
		const ref = attempt.appCredentialRef
		const now = this.now()
		const fail = this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = 'failed', state_hash = NULL, last_error_code = ?, version = version + 1, updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'credential_stored'
				AND app_credential_ref = ? AND webhook_secret_ref IS NULL RETURNING *`)
			.bind(errorCode, now, now, attempt.id, attempt.version, ref)
		const remove = this.db.prepare(`DELETE FROM vault WHERE id = ? AND scope = 'platform' AND label = ? AND EXISTS (
			SELECT 1 FROM github_source_setup_attempts WHERE id = ? AND version = ? AND status = 'failed'
				AND app_credential_ref = ?
		) RETURNING id`).bind(ref.slice('vault:'.length), githubAppCredentialSecretLabel(attempt.id), attempt.id, attempt.version + 1, ref)
		const results = await this.db.batch<GitHubSetupAttemptRow>([fail, remove]).catch(() => null)
		const row = results?.[0]?.results[0]
		return results?.[0]?.results.length === 1 && row !== undefined ? decodeAttempt(row) : null
	}

	async publishConnection(input: PublishGitHubConnectionInput): Promise<GitHubSourceConnection | null> {
		if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) throw new Error('invalid installation id')
		validateNonEmpty(input.installationAccountLogin, 'installation account')
		const verifiedRepositories = canonicalRepositories(input.verifiedRepositories)
		const attempt = await this.getAttempt(input.attemptId)
		if (
			attempt === null || attempt.version !== input.expectedVersion || attempt.status !== 'active' || attempt.phase !== 'installation_required'
			|| attempt.appId === null || attempt.appSlug === null || attempt.appHtmlUrl === null || attempt.appCredentialRef === null
			|| attempt.webhookSecretRef === null || input.installationAccountLogin.toLowerCase() !== attempt.desiredOwner.toLowerCase()
			|| JSON.stringify(verifiedRepositories) !== JSON.stringify(attempt.requestedRepositories)
			|| input.webhookUrl !== `${attempt.expectedOrigin}/webhooks/github/${encodeURIComponent(attempt.id)}`
		) return null
		const webhookVaultId = attempt.webhookSecretRef.slice('vault:'.length)
		const webhookLabel = githubWebhookSecretLabel(input.attemptId)
		const terminalAt = this.now()
		const attemptUpdate = this.db.prepare(`UPDATE github_source_setup_attempts SET
			status = 'completed', phase = 'connected', state_hash = NULL,
			version = version + 1, updated_at = ?, terminal_at = ?
			WHERE id = ? AND version = ? AND status = 'active' AND phase = 'installation_required'
				AND webhook_secret_ref = ? AND EXISTS (
					SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?
				) RETURNING *`)
			.bind(terminalAt, terminalAt, input.attemptId, input.expectedVersion, attempt.webhookSecretRef, webhookVaultId, webhookLabel)
		// When the attempt did not complete, the sentinel row breaks the `app_credential_ref` CHECK and rolls the batch back.
		const connectionInsert = this.db.prepare(`INSERT INTO github_source_connections_keyed (
			connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
			app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
			installation_account_login, installation_selection, verified_repositories_json,
			requested_repositories_json, connected_by, connected_at, verified_at, version
		) SELECT id,
			app_id, app_slug, app_html_url, desired_owner, desired_app_name, desired_public,
			app_credential_ref, ?, webhook_secret_ref, ?, ?, ?, ?, requested_repositories_json,
			initiated_by, ?, ?, 1 FROM github_source_setup_attempts
			WHERE id = ? AND version = ? AND status = 'completed' AND phase = 'connected'
				AND app_id IS NOT NULL AND app_slug IS NOT NULL AND app_html_url IS NOT NULL
				AND app_credential_ref IS NOT NULL AND webhook_secret_ref = ?
				AND EXISTS (SELECT 1 FROM vault WHERE id = ? AND scope = 'platform' AND label = ?)
			UNION ALL SELECT
				'invalid', '1', 'invalid', 'https://github.com/apps/invalid', 'invalid', 'invalid', 0,
				'invalid', 'https://invalid.example/webhooks/github', 'vault:invalid', 1, 'invalid', 'selected', '[]', '[]', 'invalid', 0, 0, 1
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
				AND (? = 'repair_required' OR app_credential_ref IS NULL) RETURNING *`)
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

function expectedSecretLabel(id: string, kind: GitHubSetupSecretKind): string {
	return kind === 'app-credential' ? githubAppCredentialSecretLabel(id) : githubWebhookSecretLabel(id)
}

function errorForExpiredPhase(phase: GitHubSetupPhase): GitHubSetupErrorCode {
	if (phase === 'credential_stored') return 'credential_activation'
	if (phase === 'app_verified') return 'credential_persistence'
	if (phase === 'webhook_secret_stored' || phase === 'webhook_configured') return 'webhook_configuration'
	if (phase === 'installation_required') return 'installation_verification'
	return 'configuration_verification'
}
