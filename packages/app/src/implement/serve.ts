// `serve(contract, { database, deps })`: how `src/app.ts` serves a contract of the staged kit. Its handlers sit
// beside their endpoints, so there is no handler tree to pass: `serve` collects the one `boot` binds by endpoint id.

import { isProcedure, type ProcedureTreeDeclaration, SURFACE_SECTIONS } from '../contract/declaration'
import type { AnyContract, Schema } from '../contract/define'
import { handlerOf, snapshotsOf } from '../contract/handled'
import { ContractError } from '../contract/problems'
import {
	type ApplicationEnvironment,
	type ContractImplementation,
	contractImplementation,
	type DepsRuntime,
	type ImplementationDatabase,
} from './implement'

/**
 * The application's dependencies, built once at `boot` from its own environment. A handler imports the module that
 * defines them and reads `get()` while it runs; at module load there is nothing to read yet.
 */
export interface AppDeps<D> {
	get(): D
}

type DepsBuild = (env: ApplicationEnvironment, runtime: DepsRuntime) => void

/** How `serve` runs a `defineDeps` build at `boot`; `AppDeps` itself exposes only `get`. */
const builds = new WeakMap<AppDeps<unknown>, DepsBuild>()

class Deps<D> implements AppDeps<D> {
	#built: { readonly value: D } | null = null

	constructor(build: (env: ApplicationEnvironment, runtime: DepsRuntime) => D) {
		builds.set(this, (env, runtime) => {
			this.#built = { value: build(env, runtime) }
		})
	}

	get(): D {
		if (this.#built === null) {
			throw new Error('the dependencies are built at boot: read deps.get() inside a handler, not at module load')
		}
		return this.#built.value
	}
}

/**
 * Declares how `boot` builds the dependencies; `serve(contract, { deps })` takes the result. Each `boot` builds them
 * anew, and `get()` answers the last build.
 */
export function defineDeps<D>(build: (env: ApplicationEnvironment, runtime: DepsRuntime) => D): AppDeps<D> {
	return new Deps(build)
}

export interface ServeOptions {
	/** `scoped(tables)` of `@fabrika/db`, which `boot` binds, or `null` for an application without tables. */
	readonly database: ImplementationDatabase | null
	readonly deps?: AppDeps<unknown>
}

/**
 * A served handler: the site's own handler, with what the site declares off the paved road (`sql`, `unscoped`,
 * `connect`, `issues`), which the context of each invocation is built from.
 */
export interface ServedHandler {
	(args: unknown): unknown
	readonly declared: unknown
}

/**
 * The contract with the handlers its endpoints carry, ready for `boot`. The default export of `src/app.ts`. Throws
 * `ContractError` naming every endpoint, job and webhook that took no `.handle(…)`.
 */
export function serve<const C extends AnyContract>(contract: C, options: ServeOptions): ContractImplementation<C> {
	const handlers = handlerTree(contract)
	const build = options.deps === undefined ? undefined : builds.get(options.deps)
	return contractImplementation({
		contract,
		database: options.database,
		connect: snapshotsOf(contract),
		handlers: (env, runtime) => {
			build?.(env, runtime)
			return handlers
		},
	})
}

/** The tree `boot` reads: one handler per procedure of each RPC and link mount, per webhook, job and export procedure. */
function handlerTree(contract: AnyContract): Record<string, unknown> {
	const missing: string[] = []
	const tree: Record<string, unknown> = {}
	for (const [name, entry] of Object.entries(contract.surface)) {
		if (SURFACE_SECTIONS.some((section) => section === name) || typeof entry !== 'object' || !('kind' in entry)) {
			continue
		}
		if (entry.kind === 'rpc') {
			tree[name] = procedureHandlers(entry.procedures, name, missing)
		} else if (entry.kind === 'link') {
			tree[name] = procedureHandlers(entry.procedures, name, missing)
		} else if (entry.kind === 'webhook') {
			tree[name] = served(entry, name, missing)
		}
	}
	const jobs = Object.entries(contract.surface.jobs ?? {})
	if (jobs.length > 0) {
		tree['jobs'] = Object.fromEntries(jobs.map(([name, job]) => [name, served(job, `jobs.${name}`, missing)]))
	}
	const exports = Object.entries(contract.surface.exports ?? {})
	if (exports.length > 0) {
		tree['exports'] = Object.fromEntries(
			exports.map(([name, declaration]) => [name, procedureHandlers(declaration.procedures, `exports.${name}`, missing)]),
		)
	}
	if (missing.length > 0) {
		throw new ContractError(
			missing.map((site) => `${site}: add .handle(…) beside its declaration; serve binds every endpoint, job and webhook to its own`),
		)
	}
	return tree
}

function procedureHandlers<Access>(tree: ProcedureTreeDeclaration<Schema, Access>, path: string, missing: string[]): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(tree).map(([name, node]) => [
			name,
			isProcedure(node) ? served(node, `${path}.${name}`, missing) : procedureHandlers(node, `${path}.${name}`, missing),
		]),
	)
}

function served(site: { readonly declared?: unknown }, path: string, missing: string[]): ServedHandler | undefined {
	const handler = handlerOf(site)
	if (typeof handler !== 'function') {
		missing.push(path)
		return undefined
	}
	return Object.assign((args: unknown): unknown => Reflect.apply(handler, undefined, [args]), { declared: site.declared ?? {} })
}
