// `Ref` and `Within`: the capabilities the framework mints after an access check. A handler receives them in `ctx`;
// it can neither construct one nor use one outside the request that obtained it. `@fabrika/db` checks the kind, the
// dimension and the action of every capability it is handed, and asks the runtime's authority whether it is authentic.
// Each `boot` makes its own issuer: its stores accept only what its own dispatcher and job runner minted, so a mint
// that application code makes, or a second runtime it boots, reaches none of them.

import {
	type AppCapability as AppCapabilityType,
	type AppGrant,
	type CapabilityAuthority,
	type CapabilityGrant,
	type ContainerGrant,
	describeGrant,
	type LeaseFence,
	MAX_WITHIN_VALUES,
	type Ref as RefCapability,
	type RefGrant,
	type RowGrant,
	type RowRef as RowRefCapability,
	type Within as WithinCapability,
	type WithinGrant,
} from '@fabrika/db/capability'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Why a capability or a handle was refused, as a closed catalog with the fixed text a log may print. */
export const CAPABILITY_REFUSALS = {
	not_minted: 'a value the framework did not mint was used as a capability; pass the ctx.target or ctx.within of this request',
	ended: 'a capability or handle was used after its request, invocation or attempt ended',
	foreign_work: 'a capability or handle was used from other work than the request it belongs to',
	wrong_target: "an IAM request was not passed this request's ctx.target",
	undeclared_action: "the job's declaration or its token does not carry the action",
	undeclared_dimension: 'the job named a dimension the contract does not declare',
	undeclared_kick: 'the site kicked a job it does not declare in kicks',
	undeclared_binding: 'the site named a webhook it does not declare in binds',
	undeclared_signs: 'the site signed a token of a purpose it does not declare in signs, or for longer than the purpose allows',
	undeclared_egress: 'the site called an origin it does not declare in egress',
	wrong_binding: 'a webhook binding was handed a capability of another kind or dimension than the webhook is bound to',
	missing_id: 'the job named an object without an id',
	wrong_capability: 'an operation was handed a capability of another dimension or action than it needs',
} as const

export type CapabilityRefusal = keyof typeof CAPABILITY_REFUSALS

/** A capability that is forged, from a request that has ended, or from another request than the current one. */
export class CapabilityRefusedError extends Error {
	override readonly name = 'CapabilityRefusedError'
	/** What a log may say; the message is for the author's own run. */
	readonly reason: CapabilityRefusal

	constructor(reason: CapabilityRefusal, message: string) {
		super(message)
		this.reason = reason
	}
}

/** A `Within` that would carry more scope values than one statement may bind; the caller is refused, not truncated. */
export class CapabilityLimitError extends Error {
	override readonly name = 'CapabilityLimitError'
}

/**
 * One request's lifetime, or one job attempt's. A capability minted in it is usable only while it runs, and only
 * inside it; a job attempt's writes also need its lease (`fence`).
 */
export class RequestFrame {
	readonly id: string
	readonly fence: LeaseFence | null
	/** An export's request: the data layer runs its every statement `READ ONLY` and refuses every write. */
	readonly readOnly: boolean
	/** The endpoint the request is served by; `ctx.connect` checks it against each import's `usedBy`. */
	readonly endpoint: string | null
	#ended = false

	constructor(
		id: string,
		options: { readonly fence?: LeaseFence | null; readonly readOnly?: boolean; readonly endpoint?: string | null } = {},
	) {
		this.id = id
		this.fence = options.fence ?? null
		this.readOnly = options.readOnly ?? false
		this.endpoint = options.endpoint ?? null
	}

	get ended(): boolean {
		return this.#ended
	}

	end(): void {
		this.#ended = true
	}
}

const currentRequest = new AsyncLocalStorage<RequestFrame>()

/** Run `work` as the request `frame`: every capability check inside it compares against this frame. */
export function runInRequest<T>(frame: RequestFrame, work: () => Promise<T>): Promise<T> {
	return currentRequest.run(frame, work)
}

/** Whether `frame` is the request running now. */
export function isActiveRequest(frame: RequestFrame): boolean {
	return currentRequest.getStore() === frame
}

/** Whether the request running now may only read; `@fabrika/db` asks it before every statement. */
export function requestIsReadOnly(): boolean {
	return currentRequest.getStore()?.readOnly === true
}

/** The module-private token that makes a `Ref` or a `Within` constructible by the framework only. */
const MINT: unique symbol = Symbol('fabrika.capability.mint')

// Captured when the module loads, before application code: a later patch to Map, Object or Reflect does not change
// how a chain is copied.
const CapturedMap = Map
const mapSet = Map.prototype.set
const mapForEach: (this: ReadonlyMap<string, string>, callback: (value: string, key: string) => void) => void = Map.prototype.forEach
const apply = Reflect.apply
const freeze = Object.freeze

type Chain = readonly (readonly [dimension: string, value: string])[]

function chainOf(map: ReadonlyMap<string, string>): Chain {
	const links: (readonly [string, string])[] = []
	apply(mapForEach, map, [
		(value: string, key: string) => {
			links[links.length] = freeze([key, value])
		},
	])
	return freeze(links)
}

/** A fresh Map of the chain: whoever holds it may change it, and the next resolution is a new copy again. */
function mapOf(chain: Chain): Map<string, string> {
	const map = new CapturedMap<string, string>()
	for (let index = 0; index < chain.length; index++) {
		const link = chain[index]
		if (link !== undefined) {
			apply(mapSet, map, [link[0], link[1]])
		}
	}
	return map
}

function copyOf(values: readonly string[]): readonly string[] {
	const copy: string[] = []
	for (let index = 0; index < values.length; index++) {
		copy[index] = values[index] ?? ''
	}
	return freeze(copy)
}

/** A frozen copy of the container grants, by index: a later patch to Array methods does not change what was minted. */
function containerGrantsOf(containers: readonly ContainerGrant[]): readonly ContainerGrant[] {
	const copy: ContainerGrant[] = []
	for (let index = 0; index < containers.length; index++) {
		const container = containers[index]
		if (container !== undefined) {
			copy[copy.length] = freeze({ dimension: container.dimension, values: copyOf(container.values) })
		}
	}
	return freeze(copy)
}

interface RefFacts {
	readonly dimension: string
	readonly action: string
	readonly principal: string
	readonly id: string
	readonly chain: Chain
}

interface Bound {
	readonly grant: CapabilityGrant
	readonly frame: RequestFrame
	/** The issuer that minted it; only that issuer's authority accepts it. */
	readonly issuer: object
}

let readRef: (value: unknown) => Bound | undefined = () => undefined
let readWithin: (value: unknown) => Bound | undefined = () => undefined
let readApp: (value: unknown) => Bound | undefined = () => undefined
let readRow: (value: unknown) => Bound | undefined = () => undefined

/** One authorized object for one action, in one request. `chain` holds the containers the object lies in. */
export class Ref<D extends string, A extends string> implements RefCapability<D, A> {
	declare readonly '~capability': { readonly kind: 'ref'; readonly dimension: D; readonly action: A }
	readonly #dimension: D
	readonly #action: A
	readonly #facts: RefFacts
	readonly #frame: RequestFrame
	readonly #issuer: object

	constructor(
		token: typeof MINT,
		issuer: object,
		frame: RequestFrame,
		dimension: D,
		action: A,
		principal: string,
		id: string,
		chain: ReadonlyMap<string, string>,
	) {
		if (token !== MINT) {
			throw new CapabilityRefusedError('not_minted', 'a Ref is minted by the framework only; declare the access form in fabrika.contract.ts')
		}
		this.#dimension = dimension
		this.#action = action
		this.#facts = freeze({ dimension, action, principal, id, chain: chainOf(chain) })
		this.#frame = frame
		this.#issuer = issuer
	}

	get dimension(): D {
		return this.#dimension
	}

	get action(): A {
		return this.#action
	}

	/** The object's id: the value of its dimension. */
	get value(): string {
		return this.#facts.id
	}

	/** The containers of the object, by dimension (`workspace → w1` for a note); a copy. */
	get chain(): ReadonlyMap<string, string> {
		return mapOf(this.#facts.chain)
	}

	static {
		readRef = (value) => {
			if (typeof value !== 'object' || value === null || !(#facts in value)) {
				return undefined
			}
			const facts = value.#facts
			const grant: RefGrant = freeze({
				kind: 'ref',
				dimension: facts.dimension,
				action: facts.action,
				principal: facts.principal,
				id: facts.id,
				chain: mapOf(facts.chain),
			})
			return { grant, frame: value.#frame, issuer: value.#issuer }
		}
	}
}

/**
 * The values of one dimension in which the caller holds one action, in one request; `all` for a global grant. The
 * containers whose grants also authorise it stay separate, so the data layer matches them against each row's chain.
 */
export class Within<D extends string, A extends string> implements WithinCapability<D, A> {
	declare readonly '~capability': { readonly kind: 'within'; readonly dimension: D; readonly action: A }
	readonly #dimension: D
	readonly #action: A
	readonly #grant: WithinGrant
	readonly #frame: RequestFrame
	readonly #issuer: object

	constructor(
		token: typeof MINT,
		issuer: object,
		frame: RequestFrame,
		dimension: D,
		action: A,
		principal: string,
		values: readonly string[] | 'all',
		containers: readonly ContainerGrant[],
	) {
		if (token !== MINT) {
			throw new CapabilityRefusedError('not_minted', 'a Within is minted by the framework only; declare the access form in fabrika.contract.ts')
		}
		const held = values === 'all' ? freeze([]) : containerGrantsOf(containers)
		let count = values === 'all' ? 0 : values.length
		for (let index = 0; index < held.length; index++) {
			count += held[index]?.values.length ?? 0
		}
		if (count > MAX_WITHIN_VALUES) {
			throw new CapabilityLimitError(
				`the caller holds '${action}' in ${count} scope values for a ${dimension} list; a Within carries at most ${MAX_WITHIN_VALUES}`,
			)
		}
		this.#dimension = dimension
		this.#action = action
		this.#grant = freeze({
			kind: 'within',
			dimension,
			action,
			principal,
			values: values === 'all' ? 'all' : copyOf(values),
			containers: held,
		})
		this.#frame = frame
		this.#issuer = issuer
	}

	get dimension(): D {
		return this.#dimension
	}

	get action(): A {
		return this.#action
	}

	/** The values of this dimension itself. */
	get values(): readonly string[] | 'all' {
		return this.#grant.values
	}

	/** The containers in which the caller also holds the action: `organization → [o1]` for a workspace list. */
	get containers(): readonly ContainerGrant[] {
		return this.#grant.containers
	}

	static {
		readWithin = (value) =>
			typeof value === 'object' && value !== null && #grant in value ? { grant: value.#grant, frame: value.#frame, issuer: value.#issuer } : undefined
	}
}

/**
 * One action held as a global grant, in one request: what an `app` endpoint's `ctx.db.app` is built from. The proxy
 * admitted the request only for a caller who holds the action without a scope.
 */
export class AppCapability<A extends string> implements AppCapabilityType<A> {
	declare readonly '~capability': { readonly kind: 'app'; readonly action: A }
	readonly #action: A
	readonly #grant: AppGrant
	readonly #frame: RequestFrame
	readonly #issuer: object

	constructor(token: typeof MINT, issuer: object, frame: RequestFrame, action: A, principal: string) {
		if (token !== MINT) {
			throw new CapabilityRefusedError('not_minted', 'an app capability is minted by the framework only; declare access: { action, app: true }')
		}
		this.#action = action
		this.#grant = freeze({ kind: 'app', action, principal })
		this.#frame = frame
		this.#issuer = issuer
	}

	get action(): A {
		return this.#action
	}

	static {
		readApp = (value) =>
			typeof value === 'object' && value !== null && #grant in value ? { grant: value.#grant, frame: value.#frame, issuer: value.#issuer } : undefined
	}
}

interface RowFacts {
	readonly table: string
	readonly action: string
	readonly principal: string
	readonly id: string
	readonly chain: Chain
}

/**
 * One row a claim leased, for one action, in one job attempt: `row.ref`, which `tx.db.on(row.ref)` finishes the row
 * through. `chain` holds the row's containment columns as it was claimed.
 */
export class RowRef<T extends string, A extends string> implements RowRefCapability<T, A> {
	declare readonly '~capability': { readonly kind: 'row'; readonly table: T; readonly action: A }
	readonly #facts: RowFacts
	readonly #frame: RequestFrame
	readonly #issuer: object

	constructor(token: typeof MINT, issuer: object, frame: RequestFrame, grant: Omit<RowGrant, 'kind'>) {
		if (token !== MINT) {
			throw new CapabilityRefusedError('not_minted', 'a row capability is minted by the framework only: claim the row')
		}
		this.#facts = freeze({ table: grant.table, action: grant.action, principal: grant.principal, id: grant.id, chain: chainOf(grant.chain) })
		this.#frame = frame
		this.#issuer = issuer
	}

	get table(): string {
		return this.#facts.table
	}

	get action(): string {
		return this.#facts.action
	}

	/** The row's key. */
	get value(): string {
		return this.#facts.id
	}

	static {
		readRow = (value) => {
			if (typeof value !== 'object' || value === null || !(#facts in value)) {
				return undefined
			}
			const facts = value.#facts
			const grant: RowGrant = freeze({
				kind: 'row',
				table: facts.table,
				action: facts.action,
				principal: facts.principal,
				id: facts.id,
				chain: mapOf(facts.chain),
			})
			return { grant, frame: value.#frame, issuer: value.#issuer }
		}
	}
}

// Application code could otherwise redefine a getter that the framework or a handler reads.
freeze(Ref.prototype)
freeze(Within.prototype)
freeze(AppCapability.prototype)
freeze(RowRef.prototype)

/** Makes the capabilities one authority accepts; a runtime's is held by the `boot` call that made it alone. */
export interface CapabilityMint {
	ref<D extends string, A extends string>(
		frame: RequestFrame,
		dimension: D,
		action: A,
		principal: string,
		id: string,
		chain: ReadonlyMap<string, string>,
	): Ref<D, A>
	within<D extends string, A extends string>(
		frame: RequestFrame,
		dimension: D,
		action: A,
		principal: string,
		values: readonly string[] | 'all',
		containers?: readonly ContainerGrant[],
	): Within<D, A>
	app<A extends string>(frame: RequestFrame, action: A, principal: string): AppCapability<A>
}

/** A mint and the one authority that accepts what it mints. */
export interface CapabilityIssuer {
	readonly mint: CapabilityMint
	readonly authority: CapabilityAuthority
}

/**
 * A new issuer: its authority refuses every capability another issuer minted. Every `boot` makes one and binds its
 * data layer and its deps to the authority; a test that needs a capability no access check gave makes another, whose
 * capabilities reach only stores bound to that issuer's authority.
 */
export function createCapabilityIssuer(): CapabilityIssuer {
	const issuer = freeze({})
	const mint: CapabilityMint = freeze({
		ref<D extends string, A extends string>(
			frame: RequestFrame,
			dimension: D,
			action: A,
			principal: string,
			id: string,
			chain: ReadonlyMap<string, string>,
		): Ref<D, A> {
			return new Ref(MINT, issuer, frame, dimension, action, principal, id, chain)
		},
		within<D extends string, A extends string>(
			frame: RequestFrame,
			dimension: D,
			action: A,
			principal: string,
			values: readonly string[] | 'all',
			containers: readonly ContainerGrant[] = [],
		): Within<D, A> {
			return new Within(MINT, issuer, frame, dimension, action, principal, values, containers)
		},
		app<A extends string>(frame: RequestFrame, action: A, principal: string): AppCapability<A> {
			return new AppCapability(MINT, issuer, frame, action, principal)
		},
	})
	const authority: CapabilityAuthority = freeze({
		resolve(capability: unknown): CapabilityGrant {
			const bound = readRef(capability) ?? readWithin(capability) ?? readApp(capability) ?? readRow(capability)
			if (bound === undefined || bound.issuer !== issuer) {
				throw new CapabilityRefusedError('not_minted', 'not a capability the framework minted: pass the ctx.target or ctx.within of this request')
			}
			const { grant, frame } = bound
			const what = `${describeGrant(grant)} for '${grant.action}'`
			if (frame.ended) {
				throw new CapabilityRefusedError(
					'ended',
					`the capability (${what}) belongs to request ${frame.id}, which has ended; never keep a capability past its request`,
				)
			}
			if (currentRequest.getStore() !== frame) {
				throw new CapabilityRefusedError(
					'foreign_work',
					`the capability (${what}) belongs to request ${frame.id}, not to the one running now; never share a capability`,
				)
			}
			return grant
		},

		row(grant: Omit<RowGrant, 'kind'>): RowRef<string, string> {
			const frame = currentRequest.getStore()
			if (frame === undefined || frame.ended) {
				throw new CapabilityRefusedError('ended', 'a claimed row is minted only inside the job attempt that claims it')
			}
			return new RowRef(MINT, issuer, frame, grant)
		},

		fence(): LeaseFence | null {
			return currentRequest.getStore()?.fence ?? null
		},
	})
	return freeze({ mint, authority })
}
