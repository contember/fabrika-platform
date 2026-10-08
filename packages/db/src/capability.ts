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

export interface WithinGrant {
	readonly kind: 'within'
	readonly dimension: string
	readonly action: string
	readonly principal: string
	/** `all` comes from a grant that is not limited to scope values. */
	readonly values: readonly string[] | 'all'
}

export type CapabilityGrant = RefGrant | WithinGrant

/**
 * The framework side of a capability. `resolve` returns what an authentic capability of the current request grants,
 * or throws when the value is not one, is forged, or belongs to a request that has ended or is not the current one.
 * The data layer checks the kind, the dimension and the action itself, on every operation.
 */
export interface CapabilityAuthority {
	resolve(capability: unknown): CapabilityGrant
}
