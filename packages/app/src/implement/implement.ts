// `implement(contract, { database, deps, handlers })`: the only way an application serves its contract. Handlers
// mirror the contract's procedure tree exactly; there is no slot for routes, middleware, authentication or a server.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import type { DataLayer } from '@fabrika/db'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import type { Session } from '@fabrika/db/framework'
import type { EmailSender } from '@fabrika/email'
import type { ConnectSnapshot } from '../contract/connect'
import type { AnyContract } from '../contract/define'
import type { ConnectSnapshots, ExactHandlers, HandlersOf } from './types'

/**
 * What the framework reads from the application's tables before a handler runs. The table policies are what
 * `compileContract` takes; `locate` resolves an object's containment chain for `on` and checks that an `in` scope
 * exists. For `@fabrika/db`'s `scoped(tables)`, `boot` builds one from the locator only it receives when it binds.
 */
export interface ContractDatabase {
	readonly tables: Readonly<Record<string, TablePolicyArtifact>>
	/**
	 * The containers an object lies in, by dimension, or `null` when the table that owns `dimension` has no such row.
	 * `using` is a job's transaction, which also sees the object it wrote; a layer of the application's own ignores it.
	 */
	locate(dimension: string, id: string, using?: Session): Promise<ReadonlyMap<string, string> | null>
}

/** `scoped(tables)` of `@fabrika/db`, which `boot` binds, or a `ContractDatabase` of the application's own. */
export type ImplementationDatabase = DataLayer | ContractDatabase

/**
 * The application's own variables: everything the platform and the operator set except the framework's. Values are
 * unchecked, so `deps` parses what it reads.
 */
export type ApplicationEnvironment = Readonly<Record<string, unknown>>

/** What the framework hands `deps`: the authority `@fabrika/db` asks whether a capability belongs to this request. */
export interface DepsRuntime {
	readonly capabilities: CapabilityAuthority
}

/** A contract with its handlers, ready for `boot`. Only `implement` and `serve` make one. */
export interface ContractImplementation<C extends AnyContract = AnyContract> {
	readonly contract: C
	readonly database: ImplementationDatabase | null
	/** The vendored snapshot of each import, by the import's name; `boot` checks each against the contract's digest. */
	readonly connect?: Readonly<Record<string, ConnectSnapshot>>
	/** Runs `deps`, then `handlers` over its result. The tree is checked by the types of `implement`, and again by `boot`. */
	readonly handlers: (env: ApplicationEnvironment, runtime: DepsRuntime) => unknown
	/** The application's own transport, built once at boot from its own variables; `null` when they configure none. */
	readonly mail?: (env: ApplicationEnvironment) => EmailSender | null
}

/**
 * Binds one handler to every procedure of the contract. `deps` runs once, at `boot`; `handlers` receives what it
 * returned and builds the handler tree, so a handler reaches its dependencies through that closure.
 */
export function implement<const C extends AnyContract, Deps, H extends HandlersOf<C, Snap>, Snap extends ConnectSnapshots<C> = ConnectSnapshots<C>>(
	contract: C,
	implementation: {
		readonly database: ImplementationDatabase | null
		/** The vendored snapshot of each import (`fabrika/connect/*.ts`), by the import's name. */
		readonly connect?: Snap
		readonly deps: (env: ApplicationEnvironment, runtime: DepsRuntime) => Deps
		readonly handlers: (deps: Deps) => H & ExactHandlers<H, C>
	},
): ContractImplementation<C> {
	const { database, connect, deps, handlers } = implementation
	return contractImplementation({
		contract,
		database,
		connect: connect ?? {},
		handlers: (env: ApplicationEnvironment, runtime: DepsRuntime) => handlers(deps(env, runtime)),
	})
}

const implementations = new WeakSet<object>()

/** The one way a `ContractImplementation` is made, by `implement` and `serve`: frozen, and known to `isContractImplementation`. */
export function contractImplementation<C extends AnyContract>(made: ContractImplementation<C>): ContractImplementation<C> {
	const frozen = Object.freeze({ ...made })
	implementations.add(frozen)
	return frozen
}

/** Whether `value` is what `implement` or `serve` returned: how a loader checks a module it imported by path. */
export function isContractImplementation(value: unknown): value is ContractImplementation {
	return typeof value === 'object' && value !== null && implementations.has(value)
}
