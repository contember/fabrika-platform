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

/**
 * One action held as a global grant: the capability of an `app` endpoint, for data of the whole application. Like a
 * `Ref`, the member is type-only.
 */
export interface AppCapability<Action extends string> {
	readonly '~capability': { readonly kind: 'app'; readonly action: Action }
}

/**
 * One claimed row of one queue table, for one action: what a claim answers as `row.ref`, and what `tx.db.on(row.ref)`
 * finishes the row through. Like a `Ref`, the member is type-only.
 */
export interface RowRef<Table extends string, Action extends string> {
	readonly '~capability': { readonly kind: 'row'; readonly table: Table; readonly action: Action }
}

export interface RefGrant {
	readonly kind: 'ref'
	readonly dimension: string
	readonly action: string
	readonly principal: string
	readonly id: string
	/** The values of the containers this object lies in, by dimension (`workspace → w1` for a note). */
	readonly chain: ReadonlyMap<string, string>
	/**
	 * The relations the caller holds the action through on this object or a container, when no grant holds it: every
	 * statement of the Ref then also requires a row of one of them. Empty for a Ref an IAM grant holds.
	 */
	readonly relations: readonly RelationHold[]
	/**
	 * The caller's grants of the action at nodes whose rows reveal the object, or a container on its chain, to their
	 * members (`memberReveals`), when no grant holds it: every statement of the Ref then also requires such a row, as
	 * for `relations`. Empty for a Ref an IAM grant holds.
	 */
	readonly revealing: readonly ContainerGrant[]
	/**
	 * The caller's grants of the action at nodes of a dimension the object's table reads through a path that holds the
	 * action (`writeThrough`), or at containers of such a node, when no grant holds it on the chain: every statement then
	 * also requires the row to reach one of them through such a path. Empty for a Ref an IAM grant holds.
	 */
	readonly paths: readonly ContainerGrant[]
}

/**
 * A relation the caller holds the action through: anywhere (`inside: null`, a `~rel` entry), or only on rows that lie
 * inside one of `inside`'s values (`~relin` entries of grants at those values): a row whose column for that dimension,
 * its key at its own dimension, names one of them. A row with no such column is not inside, so the hold reaches none.
 */
export interface RelationHold {
	readonly relation: string
	readonly inside: ContainerGrant | null
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
	/**
	 * The dimensions inside `dimension` (the listed object's own and the containers between) in which the caller holds
	 * the action: a row that lies in one of their values is listed, as a single-object read of it is allowed.
	 */
	readonly contained: readonly ContainerGrant[]
	/**
	 * The relations through which the caller also holds the action (`~rel` and `~relin` entries of its token): a row lies
	 * in the `Within` too where a row of one of them names the caller at the row's node, read by the statement itself.
	 */
	readonly relations: readonly RelationHold[]
	/**
	 * The caller's grants of the action at nodes whose rows reveal the `Within`'s dimension or a container of it to their
	 * members (`memberReveals`): a row under a node such a row reveals is read too, the statement judging the revealing row.
	 */
	readonly revealing: readonly ContainerGrant[]
	/**
	 * The nodes of tenant partitions in which the caller holds the action through a relation held inside the node (a
	 * `~relin` entry at a partition): a table's `admits` widens the `Within`'s read to its rows there that meet the
	 * condition, the statement comparing the row's own column with them (ADR-0074).
	 */
	readonly admitting: readonly ContainerGrant[]
}

/** An `app` endpoint's grant: the action everywhere in the application, which the proxy checked was held globally. */
export interface AppGrant {
	readonly kind: 'app'
	readonly action: string
	readonly principal: string
}

/** A row a claim leased: the table, its key, and the containment it had then, column by column. */
export interface RowGrant {
	readonly kind: 'row'
	readonly table: string
	readonly action: string
	readonly principal: string
	readonly id: string
	/** The row's containment columns and their values when it was claimed: a row moved since is out of reach. */
	readonly chain: ReadonlyMap<string, string>
}

export type CapabilityGrant = RefGrant | WithinGrant | AppGrant | RowGrant

/** How a refusal names a capability: `a Ref of note`, `a Within of workspace`, `an app capability`, `a row of outbox`. */
export function describeGrant(grant: CapabilityGrant): string {
	if (grant.kind === 'app') {
		return 'an app capability'
	}
	if (grant.kind === 'row') {
		return `a row of ${grant.table}`
	}
	return `a ${grant.kind === 'ref' ? 'Ref' : 'Within'} of ${grant.dimension}`
}

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
	/** Mints the capability of one claimed row, bound to the work running now as every capability is. */
	row(grant: Omit<RowGrant, 'kind'>): unknown
	/**
	 * The lease the work running now must still hold for a write to commit: the job attempt's, or `null` in a
	 * request. Every mutation checks it inside its own transaction.
	 */
	fence(): LeaseFence | null
	/**
	 * What the caller of the work running now holds of `action` in `dimension`, as a `Within` of it would carry it, with
	 * no values when it holds none; `undefined` when the work has no caller (a job attempt, a webhook delivery). An
	 * insert that hands out access through a path judges its writer by it; an authority without the method has no caller.
	 */
	standing?(dimension: string, action: string): WithinGrant | undefined
}
