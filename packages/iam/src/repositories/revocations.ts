import type { RevokedSubject } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'

/**
 * What the proxy's revocation feed reads (ADR-0022): every subject that lost something at or after a time. It is read
 * from the timestamps the revocations already write, so no writer has to remember the feed: a principal disabled, a
 * session revoked (a child session dies with its parent, whose row names the same principal), a key revoked (an
 * anonymous one is its own subject, the token's `sub`) and an OAuth grant revoked.
 */
export class RevocationRepository {
	constructor(private readonly db: SqlDatabase) {}

	/** The subjects revoked at or after `since`, latest revocation each, newest first; at most `limit`. */
	async since(since: number, limit: number): Promise<RevokedSubject[]> {
		const { results } = await this.db
			.prepare(
				`SELECT subject, MAX(at) AS at FROM (
					SELECT id AS subject, disabled_at AS at FROM principals WHERE disabled_at IS NOT NULL AND disabled_at >= ?
					UNION ALL SELECT principal_id, revoked_at FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at >= ?
					UNION ALL SELECT COALESCE(principal_id, id), revoked_at FROM credentials WHERE revoked_at IS NOT NULL AND revoked_at >= ?
					UNION ALL SELECT principal_id, revoked_at FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at >= ?
				) revoked GROUP BY subject ORDER BY MAX(at) DESC, subject LIMIT ?`,
			)
			.bind(since, since, since, since, limit)
			.all<{ subject: string; at: number | string }>()
		return results.map((row) => ({ subject: row.subject, at: Number(row.at) }))
	}
}
