import type { SqlDatabase } from '@fabrika/platform'

export type ApprovalRequestDeliveryState = 'waiting' | 'fetched' | 'expired' | 'revoked'

/**
 * A key an approved request issued, waiting for its requester (ADR-0083 §8). `jwe` is the key encrypted to the
 * requester's public key, held only while `waiting`; the fetch or the deadline clears it.
 */
export interface ApprovalRequestDeliveryRow {
	request_id: string
	/** The IAM service principal the key belongs to: what the sweep revokes when nobody fetched it. */
	principal_id: string
	jwe: string | null
	state: ApprovalRequestDeliveryState
	deadline: number
	created_at: number
	updated_at: number
}

/** Keys waiting for their requester. Each transition is one conditional update on the state it leaves. */
export class ApprovalRequestDeliveryRepository {
	constructor(
		private readonly db: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	/** Keep a key for its requester; a second put of the same request (a followed execution) changes nothing. */
	async put(input: { readonly requestId: string; readonly principalId: string; readonly jwe: string; readonly deadline: number }): Promise<void> {
		const now = this.now()
		await this.db
			.prepare(`INSERT INTO approval_request_deliveries (request_id, principal_id, jwe, state, deadline, created_at, updated_at)
				VALUES (?, ?, ?, 'waiting', ?, ?, ?) ON CONFLICT (request_id) DO NOTHING`)
			.bind(input.requestId, input.principalId, input.jwe, input.deadline, now, now)
			.run()
	}

	async get(requestId: string): Promise<ApprovalRequestDeliveryRow | null> {
		return this.db.prepare('SELECT * FROM approval_request_deliveries WHERE request_id = ?').bind(requestId).first<ApprovalRequestDeliveryRow>()
	}

	/**
	 * Hand the key out once: the JWE of a waiting delivery before its deadline, cleared in the same conditional write, so
	 * of two concurrent fetches one gets it and the other nothing. Null when it is not there to take.
	 */
	async take(requestId: string): Promise<string | null> {
		const now = this.now()
		const row = await this.db
			.prepare(`SELECT jwe FROM approval_request_deliveries WHERE request_id = ? AND state = 'waiting' AND deadline > ?`)
			.bind(requestId, now)
			.first<{ jwe: string | null }>()
		if (row === null || row.jwe === null) return null
		const taken = await this.changed(
			`UPDATE approval_request_deliveries SET state = 'fetched', jwe = NULL, updated_at = ?
			WHERE request_id = ? AND state = 'waiting' AND deadline > ?`,
			[now, requestId, now],
		)
		return taken ? row.jwe : null
	}

	/** Waiting keys whose deadline passed: `waiting` → `expired`, the JWE cleared. Answers the requests it expired. */
	async expireUnfetched(): Promise<ApprovalRequestDeliveryRow[]> {
		const now = this.now()
		const { results } = await this.db
			.prepare(`UPDATE approval_request_deliveries SET state = 'expired', jwe = NULL, updated_at = ?
				WHERE state = 'waiting' AND deadline <= ? RETURNING *`)
			.bind(now, now)
			.all<ApprovalRequestDeliveryRow>()
		return results
	}

	/** Expired keys not yet revoked in IAM. */
	async listExpired(): Promise<ApprovalRequestDeliveryRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM approval_request_deliveries WHERE state = 'expired' ORDER BY request_id`)
			.all<ApprovalRequestDeliveryRow>()
		return results
	}

	/** `expired` → `revoked`, once IAM revoked the key. */
	async markRevoked(requestId: string): Promise<boolean> {
		return this.changed(`UPDATE approval_request_deliveries SET state = 'revoked', updated_at = ? WHERE request_id = ? AND state = 'expired'`, [
			this.now(),
			requestId,
		])
	}

	private async changed(sql: string, values: (string | number | null)[]): Promise<boolean> {
		const result = await this.db.prepare(`${sql} RETURNING request_id`).bind(...values).all<{ request_id: string }>()
		return result.results.length > 0
	}
}
