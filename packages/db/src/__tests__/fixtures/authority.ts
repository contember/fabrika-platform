import type { CapabilityAuthority, CapabilityGrant, ContainerGrant, Ref, RefGrant, Within, WithinGrant } from '../../capability'
import { CapabilityError } from '../../errors'

class TestRef<D extends string, A extends string> implements Ref<D, A> {
	declare readonly '~capability': { readonly kind: 'ref'; readonly dimension: D; readonly action: A }
	readonly #grant: RefGrant
	readonly #issuer: TestAuthority

	constructor(grant: RefGrant, issuer: TestAuthority) {
		this.#grant = grant
		this.#issuer = issuer
	}

	static read(value: unknown, issuer: TestAuthority): RefGrant | undefined {
		return typeof value === 'object' && value !== null && #grant in value && value.#issuer === issuer ? value.#grant : undefined
	}
}

class TestWithin<D extends string, A extends string> implements Within<D, A> {
	declare readonly '~capability': { readonly kind: 'within'; readonly dimension: D; readonly action: A }
	readonly #grant: WithinGrant
	readonly #issuer: TestAuthority

	constructor(grant: WithinGrant, issuer: TestAuthority) {
		this.#grant = grant
		this.#issuer = issuer
	}

	static read(value: unknown, issuer: TestAuthority): WithinGrant | undefined {
		return typeof value === 'object' && value !== null && #grant in value && value.#issuer === issuer ? value.#grant : undefined
	}
}

/** Stands in for the framework: mints capabilities and resolves only its own. Request binding is not modelled. */
export class TestAuthority implements CapabilityAuthority {
	readonly #principal: string

	constructor(principal = 'user:alice') {
		this.#principal = principal
	}

	ref<const D extends string, const A extends string>(dimension: D, action: A, id: string, chain: Readonly<Record<string, string>> = {}): Ref<D, A> {
		return new TestRef({ kind: 'ref', dimension, action, principal: this.#principal, id, chain: new Map(Object.entries(chain)) }, this)
	}

	within<const D extends string, const A extends string>(
		dimension: D,
		action: A,
		values: readonly string[] | 'all',
		containers: readonly ContainerGrant[] = [],
	): Within<D, A> {
		return new TestWithin({ kind: 'within', dimension, action, principal: this.#principal, values, containers }, this)
	}

	resolve(capability: unknown): CapabilityGrant {
		const grant = TestRef.read(capability, this) ?? TestWithin.read(capability, this)
		if (grant === undefined) {
			throw new CapabilityError('not a capability of this request')
		}
		return grant
	}
}
