// `serve(contract, { database, deps })`: how `src/app.ts` serves a contract of the staged kit. Its handlers sit
// beside their endpoints, so there is no handler tree to pass; `boot` binds each by its endpoint id.

import type { AnyContract } from '../contract/define'
import { notImplemented } from '../contract/problems'
import type { ApplicationEnvironment, ContractImplementation, DepsRuntime, ImplementationDatabase } from './implement'

/**
 * The application's dependencies, built once at `boot` from its own environment. A handler imports the module that
 * defines them and reads `get()` while it runs; at module load there is nothing to read yet.
 */
export interface AppDeps<D> {
	get(): D
}

/** Declares how `boot` builds the dependencies; `serve(contract, { deps })` takes the result. */
export function defineDeps<D>(_build: (env: ApplicationEnvironment, runtime: DepsRuntime) => D): AppDeps<D> {
	return notImplemented('defineDeps', 'WU4')
}

export interface ServeOptions {
	/** `scoped(tables)` of `@fabrika/db`, which `boot` binds, or `null` for an application without tables. */
	readonly database: ImplementationDatabase | null
	readonly deps?: AppDeps<unknown>
}

/** The contract with the handlers its endpoints carry, ready for `boot`. The default export of `src/app.ts`. */
export function serve<const C extends AnyContract>(_contract: C, _options: ServeOptions): ContractImplementation<C> {
	return notImplemented('serve', 'WU4')
}
