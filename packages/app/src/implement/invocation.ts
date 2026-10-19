// One invocation of a staged-kit site — an endpoint request, a webhook delivery, a job attempt — and the `ctx.db` its
// handler reaches data through. The invocation owns one transaction, opened by the first statement: the dispatcher
// commits it after the handler returned and its output passed validation, and rolls it back otherwise. Every handle
// is bound to the invocation: called from another request, another `boot`, or after it ended, it refuses.

import { type ContractArtifact, JOB_MAILERS, type JobMailer } from '@fabrika/auth-core'
import {
	type DataAccess,
	type DataHandles,
	type DataSite,
	type InvocationTransaction,
	type QueryRefusal,
	QueryRefusedError,
	type Session,
	type SqlTag,
} from '@fabrika/db/framework'
import type { DataKind, UnscopedMode } from '@fabrika/db/tables'
import type { SqlMode } from '../contract/context'
import { DECLARED_FIELDS } from '../contract/declaration'
import type { FileSite } from '../files/collections'
import { CapabilityRefusedError, isActiveRequest, type RequestFrame } from './capability'
import { ServerFault } from './faults'

/** A site's declared off-road reach, parsed at `boot`: what its handler's `ctx` gets beyond the paved road. */
export interface SiteDeclaration {
	readonly sql: SqlMode | null
	readonly unscoped: Readonly<Record<string, UnscopedMode>>
	readonly connect: readonly string[]
	readonly issues: string | null
	readonly then: string | null
	readonly mailer: JobMailer | null
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

const NO_DECLARATION: SiteDeclaration = Object.freeze({
	sql: null,
	unscoped: Object.freeze({}),
	connect: Object.freeze([]),
	issues: null,
	then: null,
	mailer: null,
})

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
		if (!DECLARED_FIELDS.some((field) => field === key)) {
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
	const then = ownField(declared, 'then')
	if (then !== undefined && typeof then !== 'string') {
		problems.push(`${where}: then is not the name of a job`)
	}
	const mailerField = ownField(declared, 'mailer')
	const mailer = JOB_MAILERS.find((transport) => transport === mailerField) ?? null
	if (mailerField !== undefined && mailer === null) {
		problems.push(`${where}: mailer is not 'installation' or 'own'`)
	}
	return Object.freeze({
		sql: sql === 'read' || sql === 'write' ? sql : null,
		unscoped: Object.freeze(unscoped),
		connect: Object.freeze(connectors),
		issues: typeof issues === 'string' ? issues : null,
		then: typeof then === 'string' ? then : null,
		mailer,
	})
}

/**
 * The declaration a site runs with: the one the approved contract holds (`ContractArtifact.declared`, which the
 * contract's digest covers), by the site's endpoint id or `job:<name>`. A leaf whose own `declared` says otherwise is
 * refused, so a declaration only the handler tree carries never widens a site past what was approved.
 */
export function approvedDeclaration(
	where: string,
	site: string,
	leaf: unknown,
	kind: DataKind,
	artifact: ContractArtifact,
	problems: string[],
): SiteDeclaration {
	const before = problems.length
	const declared = parseDeclaration(where, leaf, kind, artifact, problems)
	const approved = approvedReach(site, artifact)
	// A leaf the parse refused is reported once, for what is wrong in it.
	if (problems.length === before && describeDeclaration(declared) !== describeDeclaration(approved)) {
		problems.push(
			`${where}: its handler declares ${describeDeclaration(declared)}, but the approved contract declares ${
				describeDeclaration(approved)
			}; declare the site's reach beside its declaration in the shell, which the contract's digest covers`,
		)
	}
	return approved
}

/** What the approved artifact declares for `site` (an endpoint id or `job:<name>`); nothing when it holds none. */
export function approvedReach(site: string, artifact: ContractArtifact): SiteDeclaration {
	const reach = artifact.declared === undefined || !Object.hasOwn(artifact.declared, site) ? undefined : artifact.declared[site]
	return reach === undefined
		? NO_DECLARATION
		: Object.freeze({
			sql: reach.sql,
			unscoped: Object.freeze({ ...reach.unscoped }),
			connect: Object.freeze([...reach.connect]),
			issues: reach.issues,
			then: reach.then ?? null,
			mailer: reach.mailer ?? null,
		})
}

/**
 * A declaration as one comparable line: its fields in a fixed order, its tables and connectors sorted; `then` and
 * `mailer` only when declared.
 */
function describeDeclaration(declaration: SiteDeclaration): string {
	const unscoped = Object.entries(declaration.unscoped).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return JSON.stringify({
		sql: declaration.sql,
		unscoped,
		connect: [...declaration.connect].sort(),
		issues: declaration.issues,
		...(declaration.then === null ? {} : { then: declaration.then }),
		...(declaration.mailer === null ? {} : { mailer: declaration.mailer }),
	})
}

/**
 * Refuses a handle used outside the work it was made for: another request, another `boot`, an ended one. `handle` names
 * it in the refusal: a `ctx.db` handle, or `ctx.sql`.
 */
export function boundTo(frame: RequestFrame, ended: () => boolean, handle = 'a ctx.db handle'): () => void {
	return () => {
		if (frame.ended || ended()) {
			throw new CapabilityRefusedError('ended', `${handle} of ${frame.id} was used after its invocation ended; never keep a handle past its handler`)
		}
		if (!isActiveRequest(frame)) {
			throw new CapabilityRefusedError('foreign_work', `${handle} of ${frame.id} was used from other work; never share a handle`)
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

	/**
	 * The handles of the site, all of them running in this invocation's transaction. A public procedure's (`reach:
	 * 'public'`) insert and read under its actions only.
	 */
	handles(kind: DataKind, declaration: SiteDeclaration, principal: string, reach: 'public' | 'declared' = 'declared'): DataHandles {
		const transaction = this.#transaction
		const site: DataSite = {
			kind,
			unscoped: declaration.unscoped,
			principal,
			check: boundTo(this.#frame, () => transaction.ended),
			session: () => transaction.session(),
			...(reach === 'public' ? { public: true } : {}),
		}
		return this.#data.handles(site)
	}

	/** `ctx.sql` of a site that declares it: its statements run in this invocation's transaction, like every handle's. */
	sql(mode: SqlMode): SqlTag {
		const transaction = this.#transaction
		return this.#data.sql({
			mode,
			check: boundTo(this.#frame, () => transaction.ended, 'ctx.sql'),
			session: () => transaction.session(),
			fail: () => transaction.fail(),
		})
	}

	/** Where `ctx.files` runs: this invocation's transaction, bound like every handle; a query's only reads. */
	fileSite(where: string, kind: DataKind): Omit<FileSite, 'frame'> {
		const transaction = this.#transaction
		return {
			where,
			check: boundTo(this.#frame, () => transaction.ended, 'ctx.files'),
			session: () => transaction.session(),
			readOnly: kind === 'mutation' && !transaction.readOnly ? null : 'a query reads only; remove files in a mutation',
			attaches: false,
		}
	}

	/** Commits; a request the caller abandoned meanwhile rolls back instead. */
	async commit(signal: AbortSignal | null): Promise<void> {
		if (signal?.aborted === true) {
			await this.#transaction.rollback()
			throw new ServerFault(
				'request_cancelled',
				`request ${this.#frame.id} was cancelled or outlived its budget before its transaction committed; nothing it wrote is kept`,
			)
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
	/** An `app` endpoint's capability, `ctx.app`. */
	readonly app?: unknown
}

/**
 * `ctx.db` of an endpoint, by its access form: the API matrix of `docs/reference/application-runtime.md`. An endpoint of
 * several capabilities binds each, as a job binds what it minted: `ctx.db.on(ref)`, `.in(ref)`, `.over(within)`.
 */
export function endpointData(
	handles: DataHandles,
	form: 'on' | 'in' | 'over' | 'creates' | 'app' | 'member' | 'capabilities',
	access: AccessCapabilities,
): object {
	const shared = { reference: handles.reference, ...(handles.unscoped === undefined ? {} : { unscoped: handles.unscoped }) }
	switch (form) {
		case 'capabilities':
			return Object.freeze({
				on: (ref: unknown) => handles.target(ref, 'on'),
				in: (ref: unknown) => handles.target(ref, 'in'),
				over: (within: unknown) => handles.within(within),
				...shared,
			})
		case 'on':
			return Object.freeze({ target: handles.target(access.target, 'on'), app: handles.app(access.target), ...shared })
		case 'in':
			return Object.freeze({ target: handles.target(access.target, 'in'), app: handles.app(access.target), ...shared })
		case 'creates':
			return Object.freeze({ created: handles.target(access.created, 'in'), ...shared })
		case 'over':
			return Object.freeze({ within: handles.within(access.within), app: handles.app(access.within), ...shared })
		case 'app':
			return Object.freeze({ app: handles.app(access.app), ...shared })
		case 'member':
			return Object.freeze(shared)
	}
}

/** `ctx.db` of a job or a webhook: each capability it minted or received binds the same handles an endpoint gets. */
export function siteData(handles: DataHandles, app: (action: string) => object): object {
	return Object.freeze({
		on: (ref: unknown) => handles.target(ref, 'on'),
		in: (ref: unknown) => handles.target(ref, 'in'),
		over: (within: unknown) => handles.within(within),
		app,
		reference: handles.reference,
		...(handles.unscoped === undefined ? {} : { unscoped: handles.unscoped }),
	})
}

/**
 * `ctx.app` and `ctx.db.app` of a webhook bound to a dimension. The types already refuse them; at run time they exist
 * only to refuse by name.
 */
export function boundWebhookApp(webhook: string): (action: string) => never {
	return () => {
		throw new CapabilityRefusedError(
			'undeclared_action',
			`webhook '${webhook}' is bound to a dimension and acts on its bound value: use ctx.refs and ctx.db.on(ref)`,
		)
	}
}

/**
 * The handles of a job attempt, outside its fenced transaction (`'job'`, each read on its own) or inside it. `tickMs`,
 * the job's schedule period, is a queue claim's first backoff.
 */
export function jobHandles(
	frame: RequestFrame,
	data: DataAccess,
	declaration: SiteDeclaration,
	principal: string,
	kind: 'job' | 'mutation',
	session: () => Promise<Session>,
	ended: () => boolean,
	tickMs?: number,
): DataHandles {
	return data.handles({
		kind,
		unscoped: declaration.unscoped,
		principal,
		check: boundTo(frame, ended),
		session,
		...(tickMs === undefined ? {} : { tickMs }),
	})
}

/**
 * A `ctx.sql` (`tx.sql`) that may not run here. The types already refuse it; at run time it exists only to refuse by
 * name, so an untyped call reports what to change rather than a `TypeError`.
 */
function refusingSql(reason: QueryRefusal, message: string): SqlTag {
	const refuse = (): never => {
		throw new QueryRefusedError(reason, message)
	}
	return Object.freeze(Object.assign(() => refuse(), { scope: () => refuse() }))
}

/** `ctx.sql` (or `member`, a job's `tx.sql`) of a site that does not declare `sql`. */
export function undeclaredSql(site: string, kind: DataKind, member: 'ctx.sql' | 'tx.sql' = 'ctx.sql'): SqlTag {
	const declaration = kind === 'query' ? "sql: 'read'" : "sql: 'read' (or 'write' to write)"
	return refusingSql('undeclared_reach', `${site} does not declare sql, so it has no ${member}; add ${declaration} to it`)
}

/** `ctx.sql` of a job that declares `sql`, outside `ctx.transaction`: its statements run only in the attempt's fence. */
export function jobSqlOutsideTransaction(job: string): SqlTag {
	return refusingSql('sql_outside_transaction', `${job} runs ctx.sql inside ctx.transaction((tx) => …), as tx.sql`)
}

/** `ctx.files` of a contract that declares no file collection: every name is refused. */
export function noFileCollections(where: string): (collection: string) => never {
	return (collection) => {
		throw new ServerFault('file_collection_unknown', `${where}: ctx.files('${String(collection)}') names a collection, and the contract declares none`)
	}
}

/** `tx.sql` of a job site that declares it: its statements run in the attempt's fenced transaction. */
export function jobSql(frame: RequestFrame, data: DataAccess, mode: SqlMode, session: Session, ended: () => boolean): SqlTag {
	return data.sql({ mode, check: boundTo(frame, ended, 'tx.sql'), session: async () => session, fail: () => session.fail() })
}
