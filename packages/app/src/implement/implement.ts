// `implement(contract, { database, deps, handlers })`: the only way an application serves its contract. Handlers
// mirror the contract's procedure tree exactly; there is no slot for routes, middleware, authentication or a server.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import type { AnyContract } from '../contract/define'
import type { ExactHandlers, HandlersOf } from './types'

/**
 * What the framework reads from the application's tables before a handler runs. The table policies are what
 * `compileContract` takes; `locate` resolves an object's containment chain for `on` and checks that an `in` scope
 * exists. A10 generates it from `src/db/tables.ts`.
 */
export interface ContractDatabase {
	readonly tables: Readonly<Record<string, TablePolicyArtifact>>
	/** The containers an object lies in, by dimension, or `null` when the table that owns `dimension` has no such row. */
	locate(dimension: string, id: string): Promise<ReadonlyMap<string, string> | null>
}

/**
 * The application's own variables: everything the platform and the operator set except the framework's. Values are
 * unchecked, so `deps` parses what it reads.
 */
export type ApplicationEnvironment = Readonly<Record<string, unknown>>

/** What the framework hands `deps`: the authority `@fabrika/db` asks whether a capability belongs to this request. */
export interface DepsRuntime {
	readonly capabilities: CapabilityAuthority
}

/** A contract with its handlers, ready for `boot`. Only `implement` makes one. */
export interface ContractImplementation<C extends AnyContract = AnyContract> {
	readonly contract: C
	readonly database: ContractDatabase | null
	/** Runs `deps`, then `handlers` over its result. The tree is checked by the types of `implement`, and again by `boot`. */
	readonly handlers: (env: ApplicationEnvironment, runtime: DepsRuntime) => unknown
}

/**
 * Binds one handler to every procedure of the contract. `deps` runs once, at `boot`; `handlers` receives what it
 * returned and builds the handler tree, so a handler reaches its dependencies through that closure.
 */
export function implement<const C extends AnyContract, Deps, H extends HandlersOf<C>>(
	contract: C,
	implementation: {
		readonly database: ContractDatabase | null
		readonly deps: (env: ApplicationEnvironment, runtime: DepsRuntime) => Deps
		readonly handlers: (deps: Deps) => H & ExactHandlers<H, C>
	},
): ContractImplementation<C> {
	const { database, deps, handlers } = implementation
	return Object.freeze({ contract, database, handlers: (env: ApplicationEnvironment, runtime: DepsRuntime) => handlers(deps(env, runtime)) })
}
