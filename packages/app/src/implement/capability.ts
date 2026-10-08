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
}

let readRef: (value: unknown) => Bound | undefined = () => undefined
let readWithin: (value: unknown) => Bound | undefined = () => undefined

/** One authorized object for one action, in one request. `chain` holds the containers the object lies in. */
export class Ref<D extends string, A extends string> implements RefCapability<D, A> {
	declare readonly '~capability': { readonly kind: 'ref'; readonly dimension: D; readonly action: A }
	readonly #dimension: D
	readonly #action: A
	readonly #facts: RefFacts
	readonly #frame: RequestFrame

	constructor(token: typeof MINT, frame: RequestFrame, dimension: D, action: A, principal: string, id: string, chain: ReadonlyMap<string, string>) {
		if (token !== MINT) {
			throw new CapabilityRefusedError('a Ref is minted by the framework only; declare the access form in fabrika.contract.ts')
		}
		this.#dimension = dimension
		this.#action = action
		this.#facts = freeze({ dimension, action, principal, id, chain: chainOf(chain) })
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
			return { grant, frame: value.#frame }
		}
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
		this.#grant = freeze({ kind: 'within', dimension, action, principal, values: values === 'all' ? 'all' : freeze([...values]) })
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

// Application code could otherwise redefine a getter that the framework or a handler reads.
freeze(Ref.prototype)
freeze(Within.prototype)

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
