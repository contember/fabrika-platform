// `serve(contract, { database, deps })`: how `src/app.ts` serves a contract of the staged kit. Its handlers sit
// beside their endpoints, so there is no handler tree to pass: `serve` collects the one `boot` binds by endpoint id.

import type { EmailSender } from '@fabrika/email'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isProcedure, type ProcedureTreeDeclaration, SURFACE_SECTIONS } from '../contract/declaration'
import type { AnyContract, Schema } from '../contract/define'
import { handlerOf, kitOriginOf, snapshotsOf } from '../contract/handled'
import { ContractError } from '../contract/problems'
import {
	type ApplicationEnvironment,
	type ContractImplementation,
	contractImplementation,
	type DepsRuntime,
	type ImplementationDatabase,
} from './implement'
import { type SiteHandler, siteHandler } from './invocation'

/**
 * The application's dependencies, built at each `boot` from its own environment. A handler imports the module that
 * defines them and reads `get()` while it runs: it answers what the boot serving that invocation built. At module load
 * there is nothing to read yet.
 */
export interface AppDeps<D> {
	get(): D
}

/** Runs `work` with one boot's dependencies as the ones `get()` answers. */
type WithDeps = <R>(work: () => R) => R

/** Builds one boot's dependencies; what `serve` runs at `boot`, since `AppDeps` itself exposes only `get`. */
type DepsBuild = (env: ApplicationEnvironment, runtime: DepsRuntime) => WithDeps

const builds = new WeakMap<AppDeps<unknown>, DepsBuild>()

class Deps<D> implements AppDeps<D> {
	/** The dependencies of the boot whose handler is running; two runtimes of one process each keep their own. */
	readonly #current = new AsyncLocalStorage<{ readonly value: D }>()

	constructor(build: (env: ApplicationEnvironment, runtime: DepsRuntime) => D) {
		builds.set(this, (env, runtime) => {
			const built = { value: build(env, runtime) }
			return (work) => this.#current.run(built, work)
		})
	}

	get(): D {
		const built = this.#current.getStore()
		if (built === undefined) {
			throw new Error('the dependencies are built at boot: read deps.get() inside a handler, not at module load')
		}
		return built.value
	}
}

/** Declares how each `boot` builds the dependencies; `serve(contract, { deps })` takes the result. */
export function defineDeps<D>(build: (env: ApplicationEnvironment, runtime: DepsRuntime) => D): AppDeps<D> {
	return new Deps(build)
}

export interface ServeOptions {
	/** `scoped(tables)` of `@fabrika/db`, which `boot` binds, or `null` for a kit without tables (`defineApp(vocabulary)`). */
	readonly database: ImplementationDatabase | null
	readonly deps?: AppDeps<unknown>
	/** The transport of the jobs that declare `mailer: 'own'`, built once at boot from the application's own variables. */
	readonly mail?: (env: ApplicationEnvironment) => EmailSender | null
}

/**
 * The contract with the handlers its endpoints carry, ready for `boot`. The default export of `src/app.ts`. Throws
 * `ContractError` naming every endpoint, job and webhook that took no `.handle(…)`.
 */
export function serve<const C extends AnyContract>(contract: C, options: ServeOptions): ContractImplementation<C> {
	const origin = kitOriginOf(contract)
	if (origin === undefined) {
		throw new ContractError(['serve: takes the contract app.contract(…) returned, itself; a copy or another object loses what the kit keeps beside it'])
	}
	handlerTree(contract, (work) => work())
	if ((origin === 'tableless') !== (options.database === null)) {
		throw new ContractError([
			origin === 'tableless'
				? 'serve: defineApp(vocabulary) declares no tables, so it takes database: null'
				: 'serve: the kit declares tables, so it takes database: scoped(tables) from @fabrika/db',
		])
	}
	const build = options.deps === undefined ? undefined : builds.get(options.deps)
	return contractImplementation({
		contract,
		database: options.database,
		connect: snapshotsOf(contract),
		handlers: (env, runtime) => handlerTree(contract, build?.(env, runtime) ?? ((work) => work())),
		...(options.mail === undefined ? {} : { mail: options.mail }),
	})
}

/**
 * The tree `boot` reads: one handler per procedure of each RPC and link mount, per webhook, job and export procedure,
 * each run with one boot's dependencies.
 */
function handlerTree(contract: AnyContract, withDeps: WithDeps): Record<string, unknown> {
	const missing: string[] = []
	const served = (site: { readonly declared?: unknown }, path: string): SiteHandler | undefined => {
		const handler = handlerOf(site)
		if (typeof handler !== 'function') {
			missing.push(path)
			return undefined
		}
		return siteHandler((args) => withDeps(() => Reflect.apply(handler, undefined, [args])), site.declared ?? {})
	}
	const procedureHandlers = <Access>(procedures: ProcedureTreeDeclaration<Schema, Access>, path: string): Record<string, unknown> =>
		Object.fromEntries(
			Object.entries(procedures).map(([name, node]) => [
				name,
				isProcedure(node) ? served(node, `${path}.${name}`) : procedureHandlers(node, `${path}.${name}`),
			]),
		)
	const tree: Record<string, unknown> = {}
	for (const [name, entry] of Object.entries(contract.surface)) {
		if (SURFACE_SECTIONS.some((section) => section === name) || typeof entry !== 'object' || !('kind' in entry)) {
			continue
		}
		if (entry.kind === 'rpc') {
			tree[name] = procedureHandlers(entry.procedures, name)
		} else if (entry.kind === 'link') {
			tree[name] = procedureHandlers(entry.procedures, name)
		} else if (entry.kind === 'webhook') {
			tree[name] = served(entry, name)
		}
	}
	const jobs = Object.entries(contract.surface.jobs ?? {})
	if (jobs.length > 0) {
		tree['jobs'] = Object.fromEntries(jobs.map(([name, job]) => [name, served(job, `jobs.${name}`)]))
	}
	const exports = Object.entries(contract.surface.exports ?? {})
	if (exports.length > 0) {
		tree['exports'] = Object.fromEntries(
			exports.map(([name, declaration]) => [name, procedureHandlers(declaration.procedures, `exports.${name}`)]),
		)
	}
	if (missing.length > 0) {
		throw new ContractError(
			missing.map((site) => `${site}: add .handle(…) beside its declaration; serve binds every endpoint, job and webhook to its own`),
		)
	}
	return tree
}
