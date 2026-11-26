import { type IamRevocationRpc, REVOCATION_FEED_WINDOW_SECONDS, type RevocationsResult } from '@fabrika/auth-core'
import { z } from 'zod'

/**
 * How long a read of IAM's revocation feed lets the proxy serve cached tokens, in seconds of the proxy's clock: the
 * bound on how long a cached token outlives a revocation (ADR-0022, "Revocation reaches a cached token").
 */
export const REVOCATION_FEED_INTERVAL_SECONDS = 5

/**
 * How far behind IAM's clock of the previous answer the next read starts. Timestamps are whole seconds, and a
 * revocation stamped before a read may commit after it; reading the overlap again costs a few repeated rows.
 */
const REVOCATION_FEED_OVERLAP_SECONDS = 10

/** IAM's answer over HTTP, parsed where it enters (`HttpIamGateway`). */
export const revocationsResultSchema: z.ZodType<RevocationsResult> = z.discriminatedUnion('ok', [
	z.object({
		ok: z.literal(true),
		now: z.number().finite(),
		complete: z.boolean(),
		subjects: z.array(z.object({ subject: z.string(), at: z.number().finite() })),
	}),
	z.object({ ok: z.literal(false), reason: z.literal('not_allowed') }),
])

/**
 * The proxy's view of IAM's revocation feed: which subjects lost a session, a key, an OAuth grant or the principal
 * itself, and when. A cached token is served only while the last read is younger than the interval and its subject
 * has no revocation at or after its `iat`; otherwise the proxy mints again and IAM decides.
 *
 * FAIL-CLOSED: no source, a failed read, a refusal or a stale read all make `admits` false, which turns the cache off
 * and every request into a mint. It holds nothing a decision depends on to allow: it only ever withholds a cached token.
 * Per process and in memory, like the token cache it guards.
 */
export class RevocationFeed {
	private readonly revoked = new Map<string, number>()
	/** After an answer that listed too many subjects: every token issued at or before this is treated as revoked. */
	private revokedThrough: number | null = null
	/** The proxy's clock when the last good read started. */
	private syncedAt: number | null = null
	/** The proxy's clock when the last read failed: an IAM without the feed is asked once an interval, not per request. */
	private failedAt: number | null = null
	/** IAM's clock: where the next read starts. `null` asks for the whole window. */
	private cursor: number | null = null
	private reading: Promise<boolean> | null = null

	constructor(
		private readonly source: IamRevocationRpc | null,
		private readonly now: () => number,
	) {}

	/** Whether a cached token of `subject`, issued at `issuedAt` (IAM's clock), may still be served. */
	async admits(subject: string, issuedAt: number): Promise<boolean> {
		if (!(await this.fresh())) return false
		if (this.revokedThrough !== null && issuedAt <= this.revokedThrough) return false
		const at = this.revoked.get(subject)
		return at === undefined || issuedAt > at
	}

	private async fresh(): Promise<boolean> {
		if (this.source === null) return false
		if (this.syncedAt !== null && this.now() - this.syncedAt < REVOCATION_FEED_INTERVAL_SECONDS) return true
		if (this.failedAt !== null && this.now() - this.failedAt < REVOCATION_FEED_INTERVAL_SECONDS) return false
		// One read at a time: concurrent requests wait for the same answer.
		this.reading ??= this.read(this.source).finally(() => {
			this.reading = null
		})
		return this.reading
	}

	private async read(source: IamRevocationRpc): Promise<boolean> {
		const started = this.now()
		let answer: RevocationsResult
		try {
			answer = await source.revocations({ since: this.cursor })
		} catch {
			// An IAM without the feed (an older release) or an unreachable one: the cache stays off until a read succeeds.
			this.failedAt = started
			return false
		}
		if (!answer.ok) {
			this.failedAt = started
			return false
		}
		this.failedAt = null
		for (const { subject, at } of answer.subjects) {
			const known = this.revoked.get(subject)
			if (known === undefined || at > known) this.revoked.set(subject, at)
		}
		if (!answer.complete) this.revokedThrough = Math.max(this.revokedThrough ?? answer.now, answer.now)
		const horizon = answer.now - REVOCATION_FEED_WINDOW_SECONDS - REVOCATION_FEED_OVERLAP_SECONDS
		for (const [subject, at] of this.revoked) {
			if (at < horizon) this.revoked.delete(subject)
		}
		this.cursor = answer.now - REVOCATION_FEED_OVERLAP_SECONDS
		this.syncedAt = started
		return true
	}
}
