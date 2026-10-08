// `Ref` and `Within`: the capabilities the framework mints after an access check. A handler receives them in `ctx`;
// it can neither construct one nor use one outside the request that obtained it. `@fabrika/db` checks the kind, the
// dimension and the action of every capability it is handed, and asks `requestCapabilities` whether it is authentic.

import type {
	CapabilityAuthority,
	CapabilityGrant,
	Ref as RefCapability,
	RefGrant,
	Within as WithinCapability,
	WithinGrant,
} from '@fabrika/db/capability'
import { AsyncLocalStorage } from 'node:async_hooks'

/** A capability that is forged, from a request that has ended, or from another request than the current one. */
export class CapabilityRefusedError extends Error {
	override readonly name = 'CapabilityRefusedError'
}

/** One request's lifetime. A capability minted in it is usable only while it runs, and only inside it. */
export class RequestFrame {
	readonly id: string
	#ended = false

	constructor(id: string) {
		this.id = id
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

/** The module-private token that makes a `Ref` or a `Within` constructible by the framework only. */
const MINT: unique symbol = Symbol('fabrika.capability.mint')

interface Bound<G extends CapabilityGrant> {
	readonly grant: G
	readonly frame: RequestFrame
}

let readRef: (value: unknown) => Bound<RefGrant> | undefined = () => undefined
let readWithin: (value: unknown) => Bound<WithinGrant> | undefined = () => undefined

/** One authorized object for one action, in one request. `chain` holds the containers the object lies in. */
export class Ref<D extends string, A extends string> implements RefCapability<D, A> {
	declare readonly '~capability': { readonly kind: 'ref'; readonly dimension: D; readonly action: A }
	readonly #dimension: D
	readonly #action: A
	readonly #grant: RefGrant
	readonly #frame: RequestFrame

	constructor(token: typeof MINT, frame: RequestFrame, dimension: D, action: A, principal: string, id: string, chain: ReadonlyMap<string, string>) {
		if (token !== MINT) {
			throw new CapabilityRefusedError('a Ref is minted by the framework only; declare the access form in fabrika.contract.ts')
		}
		this.#dimension = dimension
		this.#action = action
		this.#grant = Object.freeze({ kind: 'ref', dimension, action, principal, id, chain: new Map(chain) })
		this.#frame = frame
	}

	get dimension(): D {
		return this.#dimension
	}

	get action(): A {
		return this.#action
	}

	/** The object's id: the value of its dimension. */
	get value(): string {
		return this.#grant.id
	}

	/** The containers of the object, by dimension (`workspace → w1` for a note). */
	get chain(): ReadonlyMap<string, string> {
		return new Map(this.#grant.chain)
	}

	static {
		readRef = (value) => typeof value === 'object' && value !== null && #grant in value ? { grant: value.#grant, frame: value.#frame } : undefined
	}
}

/** The values of one dimension in which the caller holds one action, in one request; `all` for a global grant. */
export class Within<D extends string, A extends string> implements WithinCapability<D, A> {
	declare readonly '~capability': { readonly kind: 'within'; readonly dimension: D; readonly action: A }
	readonly #dimension: D
	readonly #action: A
	readonly #grant: WithinGrant
	readonly #frame: RequestFrame

	constructor(token: typeof MINT, frame: RequestFrame, dimension: D, action: A, principal: string, values: readonly string[] | 'all') {
		if (token !== MINT) {
			throw new CapabilityRefusedError('a Within is minted by the framework only; declare the access form in fabrika.contract.ts')
		}
		this.#dimension = dimension
		this.#action = action
		this.#grant = Object.freeze({ kind: 'within', dimension, action, principal, values: values === 'all' ? 'all' : Object.freeze([...values]) })
		this.#frame = frame
	}

	get dimension(): D {
		return this.#dimension
	}

	get action(): A {
		return this.#action
	}

	get values(): readonly string[] | 'all' {
		return this.#grant.values
	}

	static {
		readWithin = (value) => typeof value === 'object' && value !== null && #grant in value ? { grant: value.#grant, frame: value.#frame } : undefined
	}
}

export function mintRef<D extends string, A extends string>(
	frame: RequestFrame,
	dimension: D,
	action: A,
	principal: string,
	id: string,
	chain: ReadonlyMap<string, string>,
): Ref<D, A> {
	return new Ref(MINT, frame, dimension, action, principal, id, chain)
}

export function mintWithin<D extends string, A extends string>(
	frame: RequestFrame,
	dimension: D,
	action: A,
	principal: string,
	values: readonly string[] | 'all',
): Within<D, A> {
	return new Within(MINT, frame, dimension, action, principal, values)
}

/**
 * The framework's side of `@fabrika/db`'s capability check. It answers only whether a value is an authentic
 * capability of the request that is running now; the data layer checks the kind, the dimension and the action.
 */
export const requestCapabilities: CapabilityAuthority = Object.freeze({
	resolve(capability: unknown): CapabilityGrant {
		const bound = readRef(capability) ?? readWithin(capability)
		if (bound === undefined) {
			throw new CapabilityRefusedError('not a capability the framework minted: pass the ctx.target or ctx.within of this request')
		}
		const { grant, frame } = bound
		const what = `${grant.kind === 'ref' ? 'Ref' : 'Within'} of '${grant.dimension}' for '${grant.action}'`
		if (frame.ended) {
			throw new CapabilityRefusedError(`the ${what} belongs to request ${frame.id}, which has ended; never keep a capability past its request`)
		}
		if (currentRequest.getStore() !== frame) {
			throw new CapabilityRefusedError(`the ${what} belongs to request ${frame.id}, not to the one running now; never share a capability`)
		}
		return grant
	},
})
