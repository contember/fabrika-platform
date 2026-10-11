// One invocation of a staged-kit site — an endpoint request, a webhook delivery, a job attempt — and the `ctx.db` its
// handler reaches data through. The invocation owns one transaction, opened by the first statement: the dispatcher
// commits it after the handler returned and its output passed validation, and rolls it back otherwise. Every handle
// is bound to the invocation: called from another request, another `boot`, or after it ended, it refuses.

import type { ContractArtifact } from '@fabrika/auth-core'
import type { DataAccess, DataHandles, DataSite, InvocationTransaction, Session } from '@fabrika/db/framework'
import type { DataKind, UnscopedMode } from '@fabrika/db/tables'
import type { SqlMode } from '../contract/context'
import { notImplemented } from '../contract/problems'
import { CapabilityRefusedError, isActiveRequest, type RequestFrame } from './capability'
import { ServerFault } from './faults'

/** A site's declared off-road reach, parsed at `boot`: what its handler's `ctx` gets beyond the paved road. */
export interface SiteDeclaration {
	readonly sql: SqlMode | null
	readonly unscoped: Readonly<Record<string, UnscopedMode>>
	readonly connect: readonly string[]
	readonly issues: string | null
}

export type SiteFunction = (args: { readonly input?: unknown; readonly ctx: object }) => unknown

/**
 * A handler tree leaf of a staged-kit site, which `serve` builds from each handled endpoint, job and webhook: the
 * handler and the site's `declared` object. `boot` builds the site's `ctx.db` (and the declared handles) from it.
 */
export interface SiteHandler {
	readonly handler: SiteFunction
	readonly declared: unknown
}

const sites = new WeakSet<object>()

/** The leaf `serve` puts in the handler tree for one site. */
export function siteHandler(handler: SiteFunction, declared: unknown): SiteHandler {
	const site = Object.freeze({ handler, declared })
	sites.add(site)
	return site
}

/** Whether a handler tree node is a site leaf, rather than a group of handlers that happens to have the same fields. */
export function isSiteHandler(node: unknown): node is SiteHandler {
	return typeof node === 'object' && node !== null && sites.has(node)
}

const DECLARED_FIELDS: readonly string[] = ['sql', 'unscoped', 'connect', 'issues']
const NO_DECLARATION: SiteDeclaration = Object.freeze({ sql: null, unscoped: Object.freeze({}), connect: Object.freeze([]), issues: null })

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function ownField(record: Readonly<Record<string, unknown>>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * The site's `declared` object, parsed at the boundary: the kit's types already refused what is wrong in it, and this
 * refuses it again, because a widened or cast declaration would otherwise reach further than its site shows.
 */
export function parseDeclaration(where: string, declared: unknown, kind: DataKind, artifact: ContractArtifact, problems: string[]): SiteDeclaration {
	if (declared === undefined) {
		return NO_DECLARATION
	}
	if (!isPlainObject(declared)) {
		problems.push(`${where}: its declaration is not a plain object`)
		return NO_DECLARATION
	}
	for (const key of Object.keys(declared)) {
		if (!DECLARED_FIELDS.includes(key)) {
			problems.push(`${where}: '${key}' is no declaration (declarations: ${DECLARED_FIELDS.join(', ')})`)
		}
	}
	const reads = kind === 'query'
	const sql = ownField(declared, 'sql')
	if (sql !== undefined && sql !== 'read' && (sql !== 'write' || reads)) {
		problems.push(`${where}: sql is ${JSON.stringify(sql)}; ${reads ? "a query declares only sql: 'read'" : "sql is 'read' or 'write'"}`)
	}
	const unscoped: Record<string, UnscopedMode> = {}
	const tables = ownField(declared, 'unscoped')
	if (tables !== undefined && !isPlainObject(tables)) {
		problems.push(`${where}: unscoped is not an object of tables`)
	}
	for (const [table, mode] of Object.entries(isPlainObject(tables) ? tables : {})) {
		if (table.startsWith('fabrika_') || !Object.hasOwn(artifact.tables, table)) {
			problems.push(`${where}: unscoped declares '${table}', which is not a table of src/db/tables.ts`)
		} else if (mode === 'read' || (mode === 'write' && !reads)) {
			unscoped[table] = mode
		} else {
			problems.push(
				`${where}: unscoped declares '${table}' as ${JSON.stringify(mode)}; ${
					reads ? "a query declares only 'read'" : "the modes are 'read' and 'write'"
				}`,
			)
		}
	}
	const connect = ownField(declared, 'connect')
	const connectors = Array.isArray(connect) ? connect.filter((name): name is string => typeof name === 'string') : []
	if (connect !== undefined && (!Array.isArray(connect) || connectors.length !== connect.length)) {
		problems.push(`${where}: connect is not a list of connector names`)
	}
	for (const name of connectors) {
		if (!Object.hasOwn(artifact.imports, name)) {
			problems.push(`${where}: connect names '${name}', which the kit does not import`)
		}
	}
	const issues = ownField(declared, 'issues')
	if (issues !== undefined && typeof issues !== 'string') {
		problems.push(`${where}: issues is not the name of a link mount`)
	}
	return Object.freeze({
		sql: sql === 'read' || sql === 'write' ? sql : null,
		unscoped: Object.freeze(unscoped),
		connect: Object.freeze(connectors),
		issues: typeof issues === 'string' ? issues : null,
	})
}

/**
 * `ctx.sql` of a site that declares it. WU6 replaces it with the tagged template that runs in the session the site's
 * handles run in (`Invocation.session()`, or a job transaction's), so a statement commits and rolls back with them.
 */
export function sqlStub(): () => never {
	return () => notImplemented('ctx.sql', 'WU6')
}

/** Refuses a handle used outside the work it was made for: another request, another `boot`, an ended one. */
export function boundTo(frame: RequestFrame, ended: () => boolean): () => void {
	return () => {
		if (frame.ended || ended()) {
			throw new CapabilityRefusedError(`a ctx.db handle of ${frame.id} was used after its invocation ended; never keep a handle past its handler`)
		}
		if (!isActiveRequest(frame)) {
			throw new CapabilityRefusedError(`a ctx.db handle of ${frame.id} was used from other work; never share a handle`)
		}
	}
}

/** One invocation's transaction, and the data handles of its site. */
export class Invocation {
	readonly #frame: RequestFrame
	readonly #transaction: InvocationTransaction
	readonly #data: DataAccess

	constructor(frame: RequestFrame, data: DataAccess, readOnly: boolean) {
		this.#frame = frame
		this.#data = data
		this.#transaction = data.invocation(readOnly)
	}

	/** The handles of the site, all of them running in this invocation's transaction. */
	handles(kind: DataKind, declaration: SiteDeclaration, principal: string): DataHandles {
		const transaction = this.#transaction
		const site: DataSite = {
			kind,
			unscoped: declaration.unscoped,
			principal,
			check: boundTo(this.#frame, () => transaction.ended),
			session: () => transaction.session(),
		}
		return this.#data.handles(site)
	}

	/** The session `ctx.sql` runs in: the same transaction as every handle (WU6). */
	session(): Promise<Session> {
		return this.#transaction.session()
	}

	/** Commits; a request the caller abandoned meanwhile rolls back instead. */
	async commit(signal: AbortSignal | null): Promise<void> {
		if (signal?.aborted === true) {
			await this.#transaction.rollback()
			throw new ServerFault(`request ${this.#frame.id} was cancelled before its transaction committed; nothing it wrote is kept`)
		}
		await this.#transaction.commit()
	}

	rollback(): Promise<void> {
		return this.#transaction.rollback()
	}
}

/** What a request's access form handed the handler, by `ctx` name. */
export interface AccessCapabilities {
	readonly target?: unknown
	readonly within?: unknown
	readonly created?: unknown
}

/** `ctx.db` of an endpoint, by its access form: the API matrix of `docs/reference/application-runtime.md`. */
export function endpointData(handles: DataHandles, form: 'on' | 'in' | 'over' | 'creates' | 'member', access: AccessCapabilities): object {
	const shared = { reference: handles.reference, ...(handles.unscoped === undefined ? {} : { unscoped: handles.unscoped }) }
	switch (form) {
		case 'on':
			return Object.freeze({ target: handles.target(access.target, 'on'), ...shared })
		case 'in':
			return Object.freeze({ target: handles.target(access.target, 'in'), ...shared })
		case 'creates':
			return Object.freeze({ created: handles.target(access.created, 'in'), ...shared })
		case 'over':
			return Object.freeze({ within: handles.within(access.within), ...shared })
		case 'member':
			return Object.freeze(shared)
	}
}

/** `ctx.db` of a job or a webhook: each capability it minted or received binds the same handles an endpoint gets. */
export function siteData(handles: DataHandles): object {
	return Object.freeze({
		on: (ref: unknown) => handles.target(ref, 'on'),
		in: (ref: unknown) => handles.target(ref, 'in'),
		over: (within: unknown) => handles.within(within),
		reference: handles.reference,
		...(handles.unscoped === undefined ? {} : { unscoped: handles.unscoped }),
	})
}

/** The handles of a job attempt, outside its fenced transaction (`'job'`, each read on its own) or inside it. */
export function jobHandles(
	frame: RequestFrame,
	data: DataAccess,
	declaration: SiteDeclaration,
	principal: string,
	kind: 'job' | 'mutation',
	session: () => Promise<Session>,
	ended: () => boolean,
): DataHandles {
	return data.handles({ kind, unscoped: declaration.unscoped, principal, check: boundTo(frame, ended), session })
}
