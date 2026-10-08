import { type DeviceAuthorizationConsent, type StartDeviceAuthorizationInput } from '@fabrika/auth-core'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { unixNow } from './sql'

export interface DeviceAuthorizationRow {
	id: string
	app: string
	label: string
	permissions: string
	key_lifetime_seconds: number
	redemption_challenge: string
	approval_challenge: string
	expires_at: number
	next_poll_at: number
	status: 'pending' | 'approved' | 'issued' | 'denied' | 'cancelled' | 'authority_lost'
	approver_id: string | null
	consent_id: string | null
	scope_type: string | null
	scope_value: string | null
	key_expires_at: number | null
	claim_id: string | null
	credential_id: string | null
	principal_id: string | null
	issued_at: number | null
	created_at: number
}
export interface DeviceReceiptRow extends DeviceAuthorizationRow {
	revoked_at: number | null
}

export class DeviceAuthorizationRepository {
	constructor(protected readonly db: SqlDatabase) {}

	async start(input: StartDeviceAuthorizationInput): Promise<{ attemptId: string; expiresAt: number; pollIntervalSeconds: 3 }> {
		const attemptId = uuidv7()
		const now = unixNow()
		const expiresAt = now + 600
		await this.db.prepare(`INSERT INTO device_authorizations
			(id, app, label, permissions, key_lifetime_seconds, redemption_challenge, approval_challenge, expires_at, next_poll_at, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(
			attemptId,
			input.app,
			input.label,
			JSON.stringify(input.permissions),
			Math.min(input.keyLifetimeSeconds, 2592000),
			input.redemptionChallenge,
			input.approvalChallenge,
			expiresAt,
			now,
			now,
		).run()
		return { attemptId, expiresAt, pollIntervalSeconds: 3 }
	}

	get(id: string): Promise<DeviceReceiptRow | null> {
		return this.db.prepare(`SELECT d.*, c.revoked_at FROM device_authorizations d
			LEFT JOIN credentials c ON c.id = d.credential_id WHERE d.id = ?`).bind(id).first<DeviceReceiptRow>()
	}

	async poll(id: string, challenge: string): Promise<boolean> {
		const now = unixNow()
		return await this.db.prepare(`UPDATE device_authorizations SET next_poll_at = ?
			WHERE id = ? AND redemption_challenge = ? AND next_poll_at <= ? RETURNING id`)
			.bind(now + 3, id, challenge, now).first<{ id: string }>() !== null
	}

	async approve(id: string, approverId: string, consent: DeviceAuthorizationConsent): Promise<boolean> {
		return await this.db.prepare(`UPDATE device_authorizations
			SET status = 'approved', approver_id = ?, consent_id = ?, scope_type = ?, scope_value = ?, key_expires_at = ?
			WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id`)
			.bind(approverId, consent.consentId, consent.scope.type, consent.scope.value, consent.keyExpiresAt, id, unixNow()).first<{ id: string }>() !== null
	}

	async terminate(id: string, status: 'denied' | 'cancelled' | 'authority_lost'): Promise<void> {
		await this.db.prepare(`UPDATE device_authorizations SET status = ?
			WHERE id = ? AND status IN ('pending', 'approved')`).bind(status, id).run()
	}

	async deny(id: string): Promise<void> {
		await this.db.prepare(`UPDATE device_authorizations SET status = 'denied' WHERE id = ? AND status = 'pending' AND expires_at > ?`)
			.bind(id, unixNow()).run()
	}

	async issue(
		input: { attemptId: string; consentId: string; tokenHash: string; requestId: string; approverLabel: string },
	): Promise<DeviceAuthorizationRow | null> {
		const claimId = uuidv7()
		const principalId = uuidv7()
		const credentialId = uuidv7()
		const now = unixNow()
		// Every insert depends on this batch's fresh claim, including the final RETURNING witness.
		const results = await this.db.batch<DeviceAuthorizationRow>([
			this.db.prepare(`UPDATE device_authorizations SET claim_id = ?
				WHERE id = ? AND consent_id = ? AND status = 'approved' AND claim_id IS NULL
				AND expires_at > ? AND key_expires_at > ?`).bind(claimId, input.attemptId, input.consentId, now, now),
			this.db.prepare(`INSERT INTO principals (id, type, label, created_at)
				SELECT ?, 'service', label, ? FROM device_authorizations WHERE claim_id = ?`).bind(principalId, now, claimId),
			this.db.prepare(`INSERT INTO grants (id, principal_id, app, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
				SELECT ?, ?, app, permissions, scope_type, scope_value, approver_id, key_expires_at, ?
				FROM device_authorizations WHERE claim_id = ?`).bind(uuidv7(), principalId, now, claimId),
			this.db.prepare(`INSERT INTO credentials (id, token_hash, label, principal_id, app, issued_by, expires_at, created_at)
				SELECT ?, ?, label, ?, app, approver_id, key_expires_at, ? FROM device_authorizations WHERE claim_id = ?`)
				.bind(credentialId, input.tokenHash, principalId, now, claimId),
			this.db.prepare(`INSERT INTO audit_events (id, request_id, principal_id, principal_label, app, action, resource_type, resource_id, created_at)
				SELECT ?, ?, approver_id, ?, app, 'iam.credential.create', 'credential', ?, ?
				FROM device_authorizations WHERE claim_id = ?`).bind(uuidv7(), input.requestId, input.approverLabel, credentialId, now, claimId),
			this.db.prepare(`UPDATE device_authorizations SET status = 'issued', principal_id = ?, credential_id = ?, issued_at = ?
				WHERE claim_id = ? AND status = 'approved' RETURNING *`).bind(principalId, credentialId, now, claimId),
		])
		return results.at(-1)?.results[0] ?? null
	}

	async list(approverId: string, app: string, before: string | undefined, limit: number): Promise<DeviceReceiptRow[]> {
		const { results } = await this.db.prepare(`SELECT d.*, c.revoked_at FROM device_authorizations d
			LEFT JOIN credentials c ON c.id = d.credential_id
			WHERE d.approver_id = ? AND d.app = ? AND d.status = 'issued' ${before === undefined ? '' : 'AND d.id < ?'}
			ORDER BY d.id DESC LIMIT ?`).bind(approverId, app, ...(before === undefined ? [] : [before]), limit).all<DeviceReceiptRow>()
		return results
	}

	async prune(now: number): Promise<void> {
		await this.db.prepare(`DELETE FROM device_authorizations WHERE
			(status <> 'issued' AND expires_at <= ?) OR (status = 'issued' AND key_expires_at + 86400 <= ?)`).bind(now, now).run()
	}
}
