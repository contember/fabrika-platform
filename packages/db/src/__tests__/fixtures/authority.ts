import type {
	AppCapability,
	AppGrant,
	CapabilityAuthority,
	CapabilityGrant,
	ContainerGrant,
	LeaseFence,
	Ref,
	RefGrant,
	RowGrant,
	RowRef,
	Within,
	WithinGrant,
} from '../../capability'
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

class TestApp<A extends string> implements AppCapability<A> {
	declare readonly '~capability': { readonly kind: 'app'; readonly action: A }
	readonly #grant: AppGrant
	readonly #issuer: TestAuthority

	constructor(grant: AppGrant, issuer: TestAuthority) {
		this.#grant = grant
		this.#issuer = issuer
	}

	static read(value: unknown, issuer: TestAuthority): AppGrant | undefined {
		return typeof value === 'object' && value !== null && #grant in value && value.#issuer === issuer ? value.#grant : undefined
	}
}

class TestRow<T extends string, A extends string> implements RowRef<T, A> {
	declare readonly '~capability': { readonly kind: 'row'; readonly table: T; readonly action: A }
	readonly #grant: RowGrant
	readonly #issuer: TestAuthority

	constructor(grant: RowGrant, issuer: TestAuthority) {
		this.#grant = grant
		this.#issuer = issuer
	}

	static read(value: unknown, issuer: TestAuthority): RowGrant | undefined {
		return typeof value === 'object' && value !== null && #grant in value && value.#issuer === issuer ? value.#grant : undefined
	}
}

/** Stands in for the framework: mints capabilities and resolves only its own. Request binding is not modelled. */
export class TestAuthority implements CapabilityAuthority {
	readonly #principal: string
	/** The lease every mutation checks; a test sets it to stand in for a job attempt. */
	lease: LeaseFence | null = null

	constructor(principal = 'user:alice') {
		this.#principal = principal
	}

	fence(): LeaseFence | null {
		return this.lease
	}

	ref<const D extends string, const A extends string>(dimension: D, action: A, id: string, chain: Readonly<Record<string, string>> = {}): Ref<D, A> {
		return new TestRef({ kind: 'ref', dimension, action, principal: this.#principal, id, chain: new Map(Object.entries(chain)) }, this)
	}

	within<const D extends string, const A extends string>(
		dimension: D,
		action: A,
		values: readonly string[] | 'all',
		containers: readonly ContainerGrant[] = [],
		contained: readonly ContainerGrant[] = [],
	): Within<D, A> {
		return new TestWithin({ kind: 'within', dimension, action, principal: this.#principal, values, containers, contained }, this)
	}

	/** The capability of an `app` endpoint: `action` held as a global grant. */
	app<const A extends string>(action: A): AppCapability<A> {
		return new TestApp({ kind: 'app', action, principal: this.#principal }, this)
	}

	row(grant: Omit<RowGrant, 'kind'>): RowRef<string, string> {
		return new TestRow({ kind: 'row', ...grant }, this)
	}

	resolve(capability: unknown): CapabilityGrant {
		const grant = TestRef.read(capability, this) ?? TestWithin.read(capability, this) ?? TestApp.read(capability, this)
			?? TestRow.read(capability, this)
		if (grant === undefined) {
			throw new CapabilityError('wrong_capability', 'not a capability of this request')
		}
		return grant
	}
}
