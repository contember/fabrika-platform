import { type IamRevocationRpc, REVOCATION_FEED_WINDOW_SECONDS, type RevocationsResult } from '@fabrika/auth-core'
import { z } from 'zod'
import { type ProxyLogger, silentLogger } from './log'

/**
 * How long a read of IAM's revocation feed lets the proxy serve cached tokens, in seconds of the proxy's clock: the
 * bound on how long a cached token outlives a revocation (ADR-0022, "Revocation reaches a cached token").
 */
export const REVOCATION_FEED_INTERVAL_SECONDS = 5

/**
 * The slack between IAM's clocks, in seconds. A revocation is stamped before it commits, and a mint that read the
 * session just before the commit stamps its `iat` after it, possibly on another IAM instance: so a token issued up to
 * this long after a revocation of its subject is treated as revoked, and each read starts this far behind the previous
 * answer. It assumes the stamp-to-commit lag and the skew between IAM instances stay under it.
 */
const REVOCATION_FEED_SLACK_SECONDS = 10

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
 * has no revocation that could postdate its `iat`; otherwise the proxy mints again and IAM decides.
 *
 * FAIL-CLOSED: no source, a failed read, a refusal, a read past its deadline and a stale read all make `admits` false,
 * which turns the cache off and every request into a mint. It holds nothing a decision depends on to allow: it only
 * ever withholds a cached token. Per process and in memory, like the token cache it guards.
 */
export class RevocationFeed {
	private readonly revoked = new Map<string, number>()
	/** After an answer that listed too many subjects: every token issued up to this (plus the slack) is treated as revoked. */
	private revokedThrough: number | null = null
	/** IAM's clock of the newest answer: the next read starts the slack behind it. `null` asks for the whole window. */
	private answeredAt: number | null = null
	/** The proxy's clock when the newest good read started. */
	private syncedAt: number | null = null
	/** The proxy's clock when the last read failed: an IAM without the feed is asked once an interval, not per request. */
	private failedAt: number | null = null
	/** Whether the last read failed, so a change of state is logged once, not per request. */
	private failing = false
	private reading: { readonly promise: Promise<boolean>; readonly startedAt: number } | null = null

	constructor(
		private readonly source: IamRevocationRpc | null,
		private readonly now: () => number,
		private readonly logger: ProxyLogger = silentLogger,
		/** How long a request waits for a read, in milliseconds of real time. */
		private readonly deadlineMs = REVOCATION_FEED_INTERVAL_SECONDS * 1000,
	) {}

	/** Whether a cached token of `subject`, issued at `issuedAt` (IAM's clock), may still be served. */
	async admits(subject: string, issuedAt: number): Promise<boolean> {
		if (!(await this.fresh())) return false
		if (this.revokedThrough !== null && issuedAt <= this.revokedThrough + REVOCATION_FEED_SLACK_SECONDS) return false
		const at = this.revoked.get(subject)
		return at === undefined || issuedAt > at + REVOCATION_FEED_SLACK_SECONDS
	}

	private async fresh(): Promise<boolean> {
		if (this.source === null) return false
		const now = this.now()
		if (this.syncedAt !== null && now - this.syncedAt < REVOCATION_FEED_INTERVAL_SECONDS) return true
		if (this.failedAt !== null && now - this.failedAt < REVOCATION_FEED_INTERVAL_SECONDS) return false
		// One read at a time: concurrent requests wait for the same answer. A read older than the interval is left behind,
		// because a runtime may never settle it (a Worker cancels the I/O of the request that started it).
		if (this.reading === null || now - this.reading.startedAt >= REVOCATION_FEED_INTERVAL_SECONDS) {
			const promise = this.read(this.source, now).finally(() => {
				if (this.reading?.promise === promise) this.reading = null
			})
			this.reading = { promise, startedAt: now }
		}
		return this.withinDeadline(this.reading.promise)
	}

	/** Each waiting request bounds its own wait, with a timer of its own request. */
	private async withinDeadline(read: Promise<boolean>): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.deadlineMs)
		})
		try {
			return await Promise.race([read, deadline])
		} finally {
			clearTimeout(timer)
		}
	}

	private async read(source: IamRevocationRpc, started: number): Promise<boolean> {
		let answer: RevocationsResult
		try {
			answer = await source.revocations({ since: this.answeredAt === null ? null : this.answeredAt - REVOCATION_FEED_SLACK_SECONDS })
		} catch {
			// An IAM without the feed (an older release) or an unreachable one: the cache stays off until a read succeeds.
			return this.failed(started)
		}
		if (!answer.ok) return this.failed(started)
		for (const { subject, at } of answer.subjects) {
			const known = this.revoked.get(subject)
			if (known === undefined || at > known) this.revoked.set(subject, at)
		}
		if (!answer.complete) this.revokedThrough = Math.max(this.revokedThrough ?? answer.now, answer.now)
		const horizon = answer.now - REVOCATION_FEED_WINDOW_SECONDS - REVOCATION_FEED_SLACK_SECONDS
		for (const [subject, at] of this.revoked) {
			if (at < horizon) this.revoked.delete(subject)
		}
		// A read left behind may settle after a newer one: it never moves the state back.
		this.answeredAt = Math.max(this.answeredAt ?? answer.now, answer.now)
		this.syncedAt = Math.max(this.syncedAt ?? started, started)
		this.failedAt = null
		if (this.failing) {
			this.failing = false
			this.logger.info('revocation feed restored', { operation: 'revocations' })
		}
		return true
	}

	private failed(started: number): false {
		this.failedAt = Math.max(this.failedAt ?? started, started)
		if (!this.failing) {
			this.failing = true
			this.logger.warn('revocation feed unavailable; serving no cached token', { operation: 'revocations' })
		}
		return false
	}
}
