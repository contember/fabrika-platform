// The handler types of a contract's jobs: one handler per `c.cron` job under `handlers.jobs`, each with a context
// that reaches only the actions the job declares. A job has no request and no caller, so there is no `input`.

import type { CronJob, DimensionOf } from '../contract/define'
import type { Ref, Within } from '../implement/capability'

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
}

export type JobHandler<A extends string, D extends string> = (args: { readonly ctx: JobContext<A, D> }) => void | Promise<void>

type JobsOf<C> = C extends { readonly surface: { readonly jobs: infer J } } ? J : never

/** `{ jobs: { <name>: handler } }` for a contract that declares jobs, and nothing for one that declares none. */
export type JobHandlersOf<C> = [JobsOf<C>] extends [never] ? unknown : {
	readonly jobs: {
		readonly [K in keyof JobsOf<C>]: JobsOf<C>[K] extends CronJob<infer A, string> ? JobHandler<A, DimensionOf<C>> : never
	}
}
