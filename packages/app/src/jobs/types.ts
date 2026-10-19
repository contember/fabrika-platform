// The handler types of a contract's jobs: one handler per `c.cron` job under `handlers.jobs`, each with a context
// that reaches only the actions the job declares. A job has no request and no caller, so there is no `input`.

import type { EmailDeliveryResult, EmailSenderCapabilities } from '@fabrika/email'
import type { CronJob, DimensionOf } from '../contract/define'
import type { AppCapability, Ref, Within } from '../implement/capability'
import type { AppUrl } from '../implement/urls'

/** Who a job's writes are stamped with (`createdBy`): the job itself, never a person. */
export interface JobPrincipal {
	readonly kind: 'job'
	/** `job:<name>`. */
	readonly id: string
	readonly job: string
}

/**
 * What a job handler gets. A capability is minted for a declared action only when the token IAM signed for the job's
 * key at the start of the attempt carries it, with the job's `scope: 'app'`, and only while this attempt holds the
 * job's lease: a capability of another attempt is refused, and so is every write after the attempt timed out or lost
 * the lease.
 */
export interface JobContext<A extends string, D extends string> {
	readonly principal: JobPrincipal
	/** This attempt's id; it is also the holder of the job's lease. */
	readonly runId: string
	/** 1 for the first attempt, one more for each retry. */
	readonly attempt: number
	/** Aborted when the attempt times out or loses its lease. */
	readonly signal: AbortSignal
	/** Every value of `dimension`, for a declared action: what a list or an aggregate takes. */
	within<const Act extends A, const Dim extends D>(action: Act, dimension: Dim): Within<Dim, Act>
	/** One object of `dimension` for a declared action, located now: what a write takes. A missing object is NotFound. */
	ref<const Act extends A, const Dim extends D>(action: Act, dimension: Dim, id: string): Promise<Ref<Dim, Act>>
	/** A declared action, application-wide: what `ctx.db.app('<action>')` reads and writes the application tables with. */
	app<const Act extends A>(action: Act): AppCapability<Act>
	/** An absolute link to a procedure of this application: `ctx.url('api.mail.unsubscribe', { query: { t } })`. */
	readonly url: AppUrl
}

/** One message a job sends. The framework prefixes `idempotencyKey` before the transport sees it. */
export interface AppMailMessage {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	/** 1..200 visible ASCII characters, unique per message within this application environment. */
	readonly idempotencyKey: string
	readonly replyTo?: string
	readonly fromName?: string
	/**
	 * A one-click unsubscribe (RFC 8058): the transport writes `List-Unsubscribe` and `List-Unsubscribe-Post`. `url` is
	 * an `https:` link, usually `ctx.url` of a public procedure that verifies a signed token.
	 */
	readonly unsubscribe?: { readonly url: string }
}

/** `ctx.mail` of a job that declares `mailer`. */
export interface AppMail {
	/**
	 * false where the installation has no mail transport (`FABRIKA_EMAIL_PROVIDER=none`, or a local one without any):
	 * every `send` fails `mail_not_configured`, outcome `not_sent`. An outbox then leaves its rows queued and spends no
	 * attempt; they leave on the first run after the operator adds a transport and the application is deployed again.
	 */
	readonly available: boolean
	/** What the transport promises: whether a repeat under one key is deduplicated, sync or queued acceptance. */
	readonly capabilities: EmailSenderCapabilities
	/**
	 * Hands one message to the transport. Rejects with `EmailDeliveryError`; its `outcome` says whether the message may
	 * have left. `signal` adds to the attempt's own `ctx.signal`, which always aborts the send.
	 */
	send(message: AppMailMessage, signal?: AbortSignal): Promise<EmailDeliveryResult>
	/** `mayRetryDelivery` over this transport: true only for an `EmailDeliveryError` that is safe to send again. */
	mayRetry(error: unknown): boolean
}

export type JobHandler<A extends string, D extends string> = (args: { readonly ctx: JobContext<A, D> }) => void | Promise<void>

type JobsOf<C> = C extends { readonly surface: { readonly jobs: infer J } } ? J : never

/** `{ jobs: { <name>: handler } }` for a contract that declares jobs, and nothing for one that declares none. */
export type JobHandlersOf<C> = [JobsOf<C>] extends [never] ? unknown : {
	readonly jobs: {
		readonly [K in keyof JobsOf<C>]: JobsOf<C>[K] extends CronJob<infer A, string> ? JobHandler<A, DimensionOf<C>> : never
	}
}
