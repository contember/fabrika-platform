/**
 * One authorized object, for one action. The framework mints the class that implements it; this package never
 * constructs one. The `~capability` member is type-only: the implementing class declares it so that
 * `Ref<'note', 'notes.read'>` and `Ref<'note', 'notes.delete'>` stay distinct types, and nothing reads it at runtime.
 */
export interface Ref<Dim extends string, Action extends string> {
	readonly '~capability': { readonly kind: 'ref'; readonly dimension: Dim; readonly action: Action }
}

/** The scope values of one dimension in which the caller holds one action. */
export interface Within<Dim extends string, Action extends string> {
	readonly '~capability': { readonly kind: 'within'; readonly dimension: Dim; readonly action: Action }
}

export interface RefGrant {
	readonly kind: 'ref'
	readonly dimension: string
	readonly action: string
	readonly principal: string
	readonly id: string
	/** The values of the containers this object lies in, by dimension (`workspace → w1` for a note). */
	readonly chain: ReadonlyMap<string, string>
}

/** The values of one container dimension in which the caller holds the action: `organization → [o1]`. */
export interface ContainerGrant {
	readonly dimension: string
	readonly values: readonly string[]
}

/**
 * The most scope values one `Within` carries, its own and its containers' together. Each becomes one bound
 * parameter of every statement the `Within` scopes; Postgres binds at most 65535.
 */
export const MAX_WITHIN_VALUES = 1000

export interface WithinGrant {
	readonly kind: 'within'
	readonly dimension: string
	readonly action: string
	readonly principal: string
	/** The values of `dimension` itself; `all` comes from a grant that is not limited to scope values. */
	readonly values: readonly string[] | 'all'
	/**
	 * The containers of `dimension` whose grants also authorise this `Within`. They stay separate from `values`, so
	 * every statement judges a row by the chain columns it carries now: a scope moved out of a container is out.
	 */
	readonly containers: readonly ContainerGrant[]
}

export type CapabilityGrant = RefGrant | WithinGrant

/** One generation of a job's lease, held by one attempt. A write of the attempt commits only while it still holds it. */
export interface LeaseFence {
	readonly job: string
	/** The attempt holding the lease. */
	readonly holder: string
	readonly generation: number
}

/**
 * The framework side of a capability. `resolve` returns what an authentic capability of the current request grants,
 * or throws when the value is not one, is forged, or belongs to a request that has ended or is not the current one.
 * The data layer checks the kind, the dimension and the action itself, on every operation.
 */
export interface CapabilityAuthority {
	resolve(capability: unknown): CapabilityGrant
	/**
	 * The lease the work running now must still hold for a write to commit: the job attempt's, or `null` in a
	 * request. Every mutation checks it inside its own transaction.
	 */
	fence(): LeaseFence | null
}
