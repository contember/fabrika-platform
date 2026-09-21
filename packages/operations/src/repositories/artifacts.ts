import type { OperationsArtifactState } from '@fabrika/operations-contract'
import type { SqlDatabase } from '@fabrika/platform'

export class ArtifactsRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	async projectionDisposition(
		runId: string,
		sourceId: string,
		revision: number,
		projectionHash: string,
	): Promise<'apply' | 'unchanged' | 'stale'> {
		const existing = await this.db
			.prepare('SELECT source_id, projection_revision, projection_hash FROM deploy_run_links WHERE run_id = ?')
			.bind(runId)
			.first<{ source_id: string; projection_revision: number; projection_hash: string }>()
		if (existing === null) return 'apply'
		if (existing.source_id !== sourceId) {
			throw new ArtifactProjectionConflictError('deploy run belongs to another source')
		}
		if (existing.projection_revision > revision) return 'stale'
		if (existing.projection_revision < revision) return 'apply'
		if (existing.projection_hash !== projectionHash) {
			throw new ArtifactProjectionConflictError('deploy run revision was reused with different content')
		}
		return 'unchanged'
	}

	async upsertRelease(input: {
		id: string
		sourceId: string
		runId: string
		commitSha: string
		releaseName: string
		state: string
		artifactState: OperationsArtifactState
		finishedAt?: number
		observedAt: number
	}): Promise<ReleaseRow> {
		const now = this.now()
		const row = await this.db
			.prepare(`INSERT INTO releases
				(id, source_id, run_id, commit_sha, state, created_at, finished_at, release_name, artifact_state, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (source_id, commit_sha) DO UPDATE SET
					run_id = CASE
						WHEN releases.updated_at <= excluded.updated_at THEN excluded.run_id
						ELSE releases.run_id
					END,
					state = CASE
						WHEN releases.updated_at <= excluded.updated_at THEN excluded.state
						ELSE releases.state
					END,
					finished_at = CASE
						WHEN releases.updated_at <= excluded.updated_at THEN excluded.finished_at
						ELSE releases.finished_at
					END,
					artifact_state = CASE
						WHEN releases.updated_at <= excluded.updated_at THEN excluded.artifact_state
						ELSE releases.artifact_state
					END,
					updated_at = CASE
						WHEN releases.updated_at <= excluded.updated_at THEN excluded.updated_at
						ELSE releases.updated_at
					END
				WHERE releases.release_name = excluded.release_name
				RETURNING *`)
			.bind(
				input.id,
				input.sourceId,
				input.runId,
				input.commitSha,
				input.state,
				now,
				input.finishedAt ?? null,
				input.releaseName,
				input.artifactState,
				input.observedAt,
			)
			.first<ReleaseRow>()
		if (row === null) throw new ArtifactProjectionConflictError('release identity conflicts with an existing commit')
		return row
	}

	async reconcileRunLink(input: {
		runId: string
		sourceId: string
		releaseId: string | null
		availability: 'available' | 'unavailable'
		unavailableReason: string | null
		phase: string
		providerRunId: string | null
		outcome: string | null
		artifactState: OperationsArtifactState
		revision: number
		projectionHash: string
		observedAt: number
	}): Promise<'applied' | 'unchanged' | 'stale'> {
		const disposition = await this.projectionDisposition(input.runId, input.sourceId, input.revision, input.projectionHash)
		if (disposition !== 'apply') return disposition
		await this.db
			.prepare(`INSERT INTO deploy_run_links
				(run_id, source_id, release_id, availability, unavailable_reason, phase, provider_run_id, outcome,
					artifact_state, projection_revision, projection_hash, observed_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (run_id) DO UPDATE SET
					release_id = excluded.release_id,
					availability = excluded.availability,
					unavailable_reason = excluded.unavailable_reason,
					phase = excluded.phase,
					provider_run_id = excluded.provider_run_id,
					outcome = excluded.outcome,
					artifact_state = excluded.artifact_state,
					projection_revision = excluded.projection_revision,
					projection_hash = excluded.projection_hash,
					observed_at = excluded.observed_at,
					updated_at = excluded.updated_at
				WHERE deploy_run_links.source_id = excluded.source_id
					AND deploy_run_links.projection_revision < excluded.projection_revision`)
			.bind(
				input.runId,
				input.sourceId,
				input.releaseId,
				input.availability,
				input.unavailableReason,
				input.phase,
				input.providerRunId,
				input.outcome,
				input.artifactState,
				input.revision,
				input.projectionHash,
				input.observedAt,
				this.now(),
			)
			.run()
		return 'applied'
	}

	async putUploadCredential(input: {
		id: string
		runId: string
		releaseId: string
		verifier: string
		expiresAt: number
	}): Promise<boolean> {
		const row = await this.db
			.prepare(`INSERT INTO artifact_upload_credentials
				(id, run_id, release_id, verifier, expires_at, revoked_at)
				VALUES (?, ?, ?, ?, ?, NULL)
				ON CONFLICT (run_id) DO UPDATE SET
					expires_at = CASE
						WHEN artifact_upload_credentials.expires_at < excluded.expires_at THEN excluded.expires_at
						ELSE artifact_upload_credentials.expires_at
					END
				WHERE artifact_upload_credentials.release_id = excluded.release_id
					AND artifact_upload_credentials.verifier = excluded.verifier
				RETURNING id`)
			.bind(input.id, input.runId, input.releaseId, input.verifier, input.expiresAt)
			.first<{ id: string }>()
		return row !== null
	}

	async resolveUploadCredential(verifier: string, at: number = this.now()): Promise<ArtifactUploadCredentialResolution | null> {
		const row = await this.db
			.prepare(`SELECT
					credential.id AS credential_id,
					credential.run_id,
					credential.release_id,
					source.id AS source_id,
					source.app_id,
					source.environment,
					source.service_key,
					release.release_name
				FROM artifact_upload_credentials credential
				JOIN releases release ON release.id = credential.release_id
				JOIN sources source ON source.id = release.source_id
				JOIN deploy_run_links run ON run.run_id = credential.run_id
				WHERE credential.verifier = ?
					AND credential.revoked_at IS NULL
					AND credential.expires_at > ?
					AND source.enabled = 1
					AND run.release_id = release.id
					AND run.availability = 'available'`)
			.bind(verifier, at)
			.first<ArtifactUploadCredentialResolution>()
		return row
	}

	async indexSourceMap(input: {
		credentialId: string
		releaseId: string
		logicalPath: string
		digest: string
		byteLength: number
		blobKey: string
		operationId: string
		maxArtifacts: number
		maxBytes: number
	}): Promise<'inserted' | 'unchanged' | 'conflict' | 'limit'> {
		const results = await this.db.batch<{ id?: string; digest?: string }>([
			this.db
				.prepare(`UPDATE artifact_upload_credentials SET
						uploaded_bytes = uploaded_bytes + ?,
						artifact_count = artifact_count + 1,
						last_upload_id = ?
					WHERE id = ? AND release_id = ? AND revoked_at IS NULL AND expires_at > ?
						AND artifact_count < ?
						AND uploaded_bytes + ? <= ?
						AND NOT EXISTS (
							SELECT 1 FROM source_maps WHERE release_id = ? AND file_name = ?
						)
					RETURNING id`)
				.bind(
					input.byteLength,
					input.operationId,
					input.credentialId,
					input.releaseId,
					this.now(),
					input.maxArtifacts,
					input.byteLength,
					input.maxBytes,
					input.releaseId,
					input.logicalPath,
				),
			this.db
				.prepare(`INSERT INTO source_maps
					(release_id, file_name, blob_key, uploaded_at, digest, byte_length)
					SELECT ?, ?, ?, ?, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM artifact_upload_credentials
						WHERE id = ? AND release_id = ? AND last_upload_id = ?
					)
					ON CONFLICT (release_id, file_name) DO NOTHING
					RETURNING digest`)
				.bind(
					input.releaseId,
					input.logicalPath,
					input.blobKey,
					this.now(),
					input.digest,
					input.byteLength,
					input.credentialId,
					input.releaseId,
					input.operationId,
				),
		])
		if (results[1]?.results[0]?.digest === input.digest) return 'inserted'
		const existing = await this.db
			.prepare('SELECT digest FROM source_maps WHERE release_id = ? AND file_name = ?')
			.bind(input.releaseId, input.logicalPath)
			.first<{ digest: string | null }>()
		if (existing === null) return 'limit'
		return existing.digest === input.digest ? 'unchanged' : 'conflict'
	}

	// A release name is unique per source only, so the event's own source has to scope the lookup.
	async sourceMapKey(sourceId: string, releaseName: string, logicalPath: string): Promise<string | null> {
		const row = await this.db
			.prepare(`SELECT map.blob_key FROM source_maps map
				JOIN releases release ON release.id = map.release_id
				WHERE release.source_id = ? AND release.release_name = ? AND map.file_name = ?`)
			.bind(sourceId, releaseName, logicalPath)
			.first<{ blob_key: string }>()
		return row?.blob_key ?? null
	}
}

export interface ReleaseRow {
	id: string
	source_id: string
	run_id: string
	commit_sha: string
	state: string
	created_at: number | string
	finished_at: number | string | null
	release_name: string
	artifact_state: OperationsArtifactState
	updated_at: number | string
}

export interface ArtifactUploadCredentialResolution {
	credential_id: string
	run_id: string
	release_id: string
	source_id: string
	app_id: string
	environment: string
	service_key: string
	release_name: string
}

export class ArtifactProjectionConflictError extends Error {}
