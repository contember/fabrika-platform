// The mini-ORM at runtime: the handles `ctx.db` holds, which `orm-types.ts` types. They are built for one site of one
// invocation and run every statement in that invocation's session. Every call first checks that the work running now
// is that invocation, then refuses what the site may not do with the message its types give, then runs the store's
// own checks of kind, dimension and action against the capability.

import type { OperationNode } from 'kysely'
import { BinaryOperationNode, OperatorNode, ValueNode } from 'kysely'
import { freeze, hasOwn, inSet, isSafeInteger, nameSet, namesOf, ownDescriptor, ownKeys, ownNames, parseList, setOwn } from './builtins'
import { type CapabilityGrant, describeGrant, type RefGrant } from './capability'
import type { InvocationTransaction, Session } from './database'
import { columnOf, type Compare, type Contains, parseCondition, type Primitive, type SelectState, type TableShape } from './description'
import { CapabilityError, NotFoundError, type QueryRefusal, QueryRefusedError } from './errors'
import { linksPredicate, linkValues } from './links'
import { aggregateNode, allOf, anyOf, column, cursorAlias, equals, everything, lockedSelectNode, selectNode, withCursorColumns } from './nodes'
import type { DataKind, TargetForm, UnscopedMode } from './orm-types'
import { modelOf, namesAction, type TableModels, updatableBy, visibleFor } from './policy'
import { type SqlSite, type SqlTag, sqlTag } from './sql'
import {
	actionShape,
	aggregateRows,
	type AggregateSpec,
	appKeyPredicate,
	appListPredicate,
	appRecordPredicate,
	appRowPredicate,
	childObjectPredicate,
	childScope,
	type DataLayerRuntime,
	insertIntoApplication,
	insertIntoChild,
	insertIntoDimension,
	insertRow,
	keyOf,
	objectPredicate,
	ownerOf,
	parentPredicate,
	reachColumn,
	reachPredicate,
	readValues,
	removeRow,
	type Runner,
	runtimeOf,
	scopedApplicationRead,
	scopeTerms,
	selectOne,
	selfLinks,
	type TableContext,
	updateRow,
	updatingApp,
	updatingRef,
	versionArgument,
} from './store'
import { answerDays } from './temporal'

/** A list page holds this many rows unless the caller asks for fewer, and never more than `MAX_LIST_LIMIT`. */
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 500

/** The framework's own tables; no declaration reaches one. */
const FRAMEWORK_PREFIX = 'fabrika_'

/** What every handle of one site, in one invocation, is made for. */
export interface DataSite {
	/** A query reads; a mutation also writes and locks; a job reads, and writes only in its fenced transaction. */
	readonly kind: DataKind
	/** The tables the site declares `unscoped`, each in its mode. */
	readonly unscoped: Readonly<Record<string, UnscopedMode>>
	/** Who an unscoped insert is stamped with (`createdBy`): no capability carries a principal for it. */
	readonly principal: string
	/** Throws unless the work running now is the invocation these handles were made for. */
	check(): void
	/** The session every statement of the site runs in. */
	session(): Promise<Session>
}

/** The handles of one site; the framework composes `ctx.db` from them by the site's access form. */
export interface DataHandles {
	/** `ctx.db.target` (or `ctx.db.created`, or a job's `ctx.db.on`/`.in`): a `Ref`'s row and subtree. */
	target(capability: unknown, form: TargetForm): object
	/** `ctx.db.within` (or a job's `ctx.db.over`): every table listed in a `Within`'s dimension. */
	within(capability: unknown): object
	/**
	 * `ctx.db.app`. Of an `app` endpoint: each application table, and each dimension and child table, read-only, by the
	 * capability's action held application-wide. Of an `on`, `in` or `over` endpoint (a `Ref` or a `Within`): each
	 * application table, read-only, every row, where the capability's action is its read action.
	 */
	app(capability: unknown): object
	/** `ctx.db.reference`. */
	readonly reference: object
	/** `ctx.db.unscoped`, or `undefined` for a site that declares none. */
	readonly unscoped: object | undefined
}

/** The data side of one bound layer, which only the framework reaches (`@fabrika/db/framework`). */
export interface DataAccess {
	/** One invocation's transaction over the bound connection; a query's is `READ ONLY`. */
	invocation(readOnly: boolean): InvocationTransaction
	/** A statement-at-a-time session: what a job's reads outside its transaction run in. */
	direct(): Session
	/** One transaction, fenced by the lease of the job attempt running now: a job's `ctx.transaction`. */
	transaction<T>(work: (session: Session) => Promise<T>): Promise<T>
	/** The handles of one site. Throws for a declaration this layer cannot honour. */
	handles(site: DataSite): DataHandles
	/** `ctx.sql` of a site that declares it, running in the site's session on the application's schema. */
	sql(site: SqlSite): SqlTag
}

/** What `scoped` hands this module: the layer's tables and the way to its runtime. */
export interface DataLayerParts {
	readonly models: TableModels
	contextOf(table: string): TableContext
	runtime(): DataLayerRuntime
	newSession(runtime: DataLayerRuntime): Session
	newInvocation(runtime: DataLayerRuntime, readOnly: boolean): InvocationTransaction
	fenced<T>(runtime: DataLayerRuntime, work: (session: Session) => Promise<T>): Promise<T>
}

export function dataAccess(parts: DataLayerParts): DataAccess {
	return freeze({
		invocation: (readOnly: boolean) => parts.newInvocation(parts.runtime(), readOnly),
		direct: () => parts.newSession(parts.runtime()),
		transaction: <T>(work: (session: Session) => Promise<T>) => parts.fenced(parts.runtime(), work),
		handles: (site: DataSite) => handlesOf(parts, site),
		sql: (site: SqlSite) =>
			sqlTag(
				site,
				parts.runtime().database.schema,
				(capability, table, use, assigned) => {
					if (!hasOwn(parts.models, table)) {
						throw new QueryRefusedError('unknown_table', `ctx.sql.scope: ${table} is not a table of src/db/tables.ts`)
					}
					return scopeTerms(parts.contextOf(table), capability, use, assigned)
				},
				(table) => {
					if (modelOf(parts.models, table)?.scope.mode === 'reference') {
						throw new QueryRefusedError('read_only', `ctx.sql: ${table} is a reference table, which no statement writes: its rows come from a migration`)
					}
				},
			),
	})
}

function runnerOf(site: DataSite): Runner {
	return {
		read: () => site.session(),
		write: async (work) => work(await site.session()),
	}
}

/** Every handle method checks its invocation first, so a captured one refuses before it reads its arguments. */
function bound<A extends unknown[], R>(site: DataSite, method: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
	return async (...args: A) => {
		site.check()
		return method(...args)
	}
}

/** A method this site may not call: it throws the message its type gives, whatever the arguments. */
function refused(site: DataSite, reason: QueryRefusal, message: string): () => Promise<never> {
	return async () => {
		site.check()
		throw new QueryRefusedError(reason, message)
	}
}

/** The message of a write the site's kind refuses, or `undefined` in a mutation. */
function writeRefusal(site: DataSite, operation: 'insert' | 'update' | 'remove'): string | undefined {
	if (site.kind === 'job') {
		return 'a job writes inside ctx.transaction((tx) => …): use tx.db there'
	}
	if (site.kind === 'query') {
		return `${operation} writes, so it runs only in a mutation: declare the endpoint with r.mutation`
	}
	return undefined
}

function writing<A extends unknown[], R>(
	site: DataSite,
	operation: 'insert' | 'update' | 'remove',
	method: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	const refusal = writeRefusal(site, operation)
	return refusal === undefined ? bound(site, method) : refused(site, 'read_only', refusal)
}

/** A `Ref` of `dimension` whose action the table names: a capability reads its own target and its subtree with it. */
function namedRef(context: TableContext, capability: unknown, dimension: string): RefGrant {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const table = context.model.name
	if (grant.kind !== 'ref' || grant.dimension !== dimension) {
		throw new CapabilityError('wrong_capability', `a read of ${table} here needs a Ref of ${dimension}, got ${describeGrant(grant)}`)
	}
	if (!namesAction(context.model, grant.action)) {
		throw new CapabilityError(
			'wrong_action',
			`${table} does not name the action '${grant.action}': read it from an endpoint whose action ${table} names, or declare unscoped`,
		)
	}
	return grant
}

function resolved(parts: DataLayerParts, capability: unknown): CapabilityGrant {
	return parts.runtime().capabilities.resolve(capability)
}

function handlesOf(parts: DataLayerParts, site: DataSite): DataHandles {
	const run = runnerOf(site)
	const unscoped = unscopedTables(parts, site, run)
	return freeze({
		target: (capability: unknown, form: TargetForm) => {
			site.check()
			return scopeTarget(parts, site, run, capability, form)
		},
		within: (capability: unknown) => {
			site.check()
			return withinTables(parts, site, run, capability)
		},
		app: (capability: unknown) => {
			site.check()
			return applicationTables(parts, site, run, capability)
		},
		reference: referenceTables(parts, site, run),
		unscoped,
	})
}

/** Adds one table's handle; a table named like a target member would shadow it, so it is refused instead. */
function addTable(handle: Record<string, unknown>, table: string, rows: object): void {
	if (hasOwn(handle, table)) {
		throw new QueryRefusedError('invalid_name', `the table ${table} has the name of a ctx.db.target member; rename the table`)
	}
	setOwn(handle, table, rows)
}

function scopeTarget(parts: DataLayerParts, site: DataSite, run: Runner, capability: unknown, form: TargetForm): object {
	const grant = resolved(parts, capability)
	if (grant.kind !== 'ref') {
		throw new CapabilityError('wrong_capability', 'ctx.db.target is built from a Ref; an over endpoint lists through ctx.db.within')
	}
	const dimension = grant.dimension
	const owner = ownerOf(parts.models, dimension)
	const handle: Record<string, unknown> = owner === undefined
		? unownedTarget(site, dimension)
		: targetRow(parts.contextOf(owner.name), site, run, capability, dimension, form)
	const tables = ownKeys(parts.models)
	for (let index = 0; index < tables.length; index++) {
		const model = modelOf(parts.models, tables[index] ?? '')
		if (model === undefined) {
			continue
		}
		const scope = model.scope
		if (scope.mode === 'child' && owner !== undefined && scope.parent === owner.name) {
			addTable(handle, model.name, childRows(parts.contextOf(model.name), site, run, capability))
		} else if (scope.mode === 'dimension' && scope.container?.dimension === dimension) {
			addTable(handle, model.name, containedRows(parts.contextOf(model.name), site, run, capability, dimension))
		} else if (form === 'in' && scope.mode === 'dimension' && model === owner && scope.container === undefined) {
			addTable(handle, model.name, ownerRow(parts.contextOf(model.name), site, run, capability))
		}
	}
	return freeze(handle)
}

function unownedTarget(site: DataSite, dimension: string): Record<string, unknown> {
	const message = `no table owns the dimension ${dimension}, so ctx.db.target has no row of its own`
	const refuse = refused(site, 'unknown_table', message)
	return { get: refuse, getForUpdate: refuse, update: refuse, remove: refuse }
}

/** The predicate of the target object, over the whole chain its `Ref` carries. */
function targetPredicate(context: TableContext, grant: RefGrant): OperationNode {
	return linksPredicate(context.model.name, linkValues(context.model.name, selfLinks(context.model), grant))
}

function targetRow(
	context: TableContext,
	site: DataSite,
	run: Runner,
	capability: unknown,
	dimension: string,
	form: TargetForm,
): Record<string, unknown> {
	const onOnly = (operation: string) => `${operation} acts on one object: declare access with on`
	const get = bound(site, async () => {
		const grant = namedRef(context, capability, dimension)
		return selectOne(context, run, targetPredicate(context, grant), visibleFor(context.model, grant.action))
	})
	const lock = bound(site, async () => {
		const grant = namedRef(context, capability, dimension)
		const scope = targetPredicate(context, grant)
		const node = lockedSelectNode(context.model.name, visibleFor(context.model, grant.action), scope, context.model.dates)
		const session = await run.read()
		const rows = await session.run(node, { root: 'SelectQueryNode', table: context.model.name, joins: {}, scope, lock: 'update' })
		const [row] = answerDays(context.model.name, context.model.dates, rows)
		if (row === undefined) {
			throw new NotFoundError(`${context.model.name} not found`)
		}
		return row
	})
	const getForUpdate = site.kind === 'job'
		? refused(site, 'read_only', 'a job writes inside ctx.transaction((tx) => …): use tx.db there')
		: site.kind === 'query'
		? refused(site, 'read_only', 'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation')
		: form === 'on'
		? lock
		: refused(site, 'row_address', 'getForUpdate locks one object: declare access with on')
	const update = form === 'on'
		? writing(site, 'update', async (values: unknown, ...options: unknown[]) => {
			const grant = updatingRef(context, capability, dimension)
			const changes = readValues(values, updatableBy(context.model, grant.action), 'update', context.model)
			return updateRow(context, run, { scope: targetPredicate(context, grant) }, changes, versionArgument(context, options))
		})
		: refused(site, 'row_address', onOnly('update'))
	const remove = form === 'on'
		? writing(site, 'remove', async (...options: unknown[]) => {
			const scope = objectPredicate(context, capability, 'delete')
			await removeRow(context, run, { scope }, versionArgument(context, options))
		})
		: refused(site, 'row_address', onOnly('remove'))
	return { get, getForUpdate, update, remove }
}

/** A child table of the target: its rows under the target, addressed by their own key. */
function childRows(context: TableContext, site: DataSite, run: Runner, capability: unknown): object {
	const parent = childScope(context).parent.dimension
	const key = keyOf(context.model)
	return freeze({
		list: bound(site, async (options?: unknown) => {
			const grant = namedRef(context, capability, parent)
			return listRows(context, run, parentPredicate(context, grant), visibleFor(context.model, grant.action), options, [key])
		}),
		get: bound(site, async (id: unknown) => {
			const grant = namedRef(context, capability, parent)
			if (typeof id !== 'string' || id.length === 0) {
				throw new QueryRefusedError('row_address', `a ${context.model.name} row is addressed by its ${key}, a non-empty string`)
			}
			const scope = allOf([equals(context.model.name, key, id), parentPredicate(context, grant)])
			return selectOne(context, run, scope, visibleFor(context.model, grant.action))
		}),
		insert: writing(site, 'insert', async (values: unknown) => insertIntoChild(context, run, capability, values)),
		update: writing(site, 'update', async (id: unknown, values: unknown, ...options: unknown[]) => {
			if (typeof id !== 'string' || id.length === 0) {
				throw new QueryRefusedError('row_address', `a ${context.model.name} row is addressed by its parent Ref and its ${key}`)
			}
			const grant = updatingRef(context, capability, parent)
			const changes = readValues(values, updatableBy(context.model, grant.action), 'update', context.model)
			const scope = allOf([equals(context.model.name, key, id), parentPredicate(context, grant)])
			return updateRow(context, run, { scope }, changes, versionArgument(context, options))
		}),
		remove: writing(site, 'remove', async (id: unknown, ...options: unknown[]) => {
			await removeRow(context, run, { scope: childObjectPredicate(context, capability, id, 'delete') }, versionArgument(context, options))
		}),
	})
}

/** A dimension table the target contains: its rows listed in the target, and inserted into it. */
function containedRows(context: TableContext, site: DataSite, run: Runner, capability: unknown, dimension: string): object {
	return freeze({
		list: bound(site, async (options?: unknown) => {
			const grant = namedRef(context, capability, dimension)
			const scope = linksPredicate(context.model.name, linkValues(context.model.name, context.model.chain, grant))
			return listRows(context, run, scope, visibleFor(context.model, grant.action), options, [keyOf(context.model)])
		}),
		insert: writing(site, 'insert', async (values: unknown) => insertIntoDimension(context, run, capability, values)),
	})
}

/** A top-level scope's own row, keyed by the scope's value: what an `in` or `creates` endpoint inserts. */
function ownerRow(context: TableContext, site: DataSite, run: Runner, capability: unknown): object {
	return freeze({ insert: writing(site, 'insert', async (values: unknown) => insertIntoDimension(context, run, capability, values)) })
}

function withinTables(parts: DataLayerParts, site: DataSite, run: Runner, capability: unknown): object {
	const grant = resolved(parts, capability)
	if (grant.kind !== 'within') {
		throw new CapabilityError('wrong_capability', 'ctx.db.within is built from a Within; an on or in endpoint reaches its rows through ctx.db.target')
	}
	const handle: Record<string, unknown> = {}
	const tables = ownKeys(parts.models)
	for (let index = 0; index < tables.length; index++) {
		const model = modelOf(parts.models, tables[index] ?? '')
		const listable = model?.scope.mode === 'dimension' || model?.scope.mode === 'child'
		if (model !== undefined && listable && reachColumn(model, grant.dimension) !== undefined) {
			const context = parts.contextOf(model.name)
			setOwn(handle, model.name, listedRows(context, site, run, () => reachPredicate(context, capability)))
		}
	}
	return freeze(handle)
}

/** A table read through a `Within` by its read action: `undefined` from `scope` is an empty `Within`, which reads nothing. */
function listedRows(context: TableContext, site: DataSite, run: Runner, scope: () => OperationNode | undefined): object {
	const visible = context.model.visible
	const key = [keyOf(context.model)]
	return freeze({
		list: bound(site, async (options?: unknown) => listRows(context, run, scope(), visible, options, key)),
		count: bound(site, async (options?: unknown) => countRows(context, run, scope(), visible, options)),
		aggregate: bound(site, async <Row>(spec: AggregateSpec<Row>) => aggregateRows(context, run, scope(), context.shape, spec)),
	})
}

function applicationTables(parts: DataLayerParts, site: DataSite, run: Runner, capability: unknown): object {
	const grant = resolved(parts, capability)
	if (grant.kind !== 'app') {
		return scopedApplicationTables(parts, site, run, capability)
	}
	const handle: Record<string, unknown> = {}
	const tables = ownKeys(parts.models)
	for (let index = 0; index < tables.length; index++) {
		const model = modelOf(parts.models, tables[index] ?? '')
		if (model === undefined) {
			continue
		}
		const context = parts.contextOf(model.name)
		if (model.scope.mode === 'app') {
			setOwn(handle, model.name, applicationRows(context, site, run, capability))
		} else if (model.scope.mode === 'dimension' || model.scope.mode === 'child') {
			setOwn(handle, model.name, appRecordRows(context, site, run, capability, grant.action))
		}
	}
	return freeze(handle)
}

/**
 * A dimension or child table under an `app` capability of `action`, read-only and every row, with the columns that
 * action reads (`visibleFor`): listed and aggregated with its read action or an action of its `appRead`, counted with
 * those or an action of its `appCount`.
 */
function appRecordRows(context: TableContext, site: DataSite, run: Runner, capability: unknown, action: string): object {
	const visible = visibleFor(context.model, action)
	const shape = actionShape(context.model, visible)
	const key = [keyOf(context.model)]
	return freeze({
		list: bound(site, async (options?: unknown) => listRows(context, run, appRecordPredicate(context, capability, 'rows'), visible, options, key)),
		count: bound(site, async (options?: unknown) => countRows(context, run, appRecordPredicate(context, capability, 'counts'), visible, options)),
		aggregate: bound(
			site,
			async <Row>(spec: AggregateSpec<Row>) => aggregateRows(context, run, appRecordPredicate(context, capability, 'rows'), shape, spec),
		),
	})
}

/** `ctx.db.app` of a scoped site: every application table, each read only under its read action (`scopedApplicationRead`). */
function scopedApplicationTables(parts: DataLayerParts, site: DataSite, run: Runner, capability: unknown): object {
	const handle: Record<string, unknown> = {}
	const tables = ownKeys(parts.models)
	for (let index = 0; index < tables.length; index++) {
		const model = modelOf(parts.models, tables[index] ?? '')
		if (model?.scope.mode === 'app') {
			setOwn(handle, model.name, scopedApplicationRows(parts.contextOf(model.name), site, run, capability))
		}
	}
	return freeze(handle)
}

/** An application table read from a scoped site: listed, counted, aggregated and read by key, every row, writing nothing. */
function scopedApplicationRows(context: TableContext, site: DataSite, run: Runner, capability: unknown): object {
	const model = context.model
	const visible = model.visible
	const key = [keyOf(model)]
	const scope = () => scopedApplicationRead(context, capability)
	return freeze({
		list: bound(site, async (options?: unknown) => listRows(context, run, scope(), visible, options, key)),
		count: bound(site, async (options?: unknown) => countRows(context, run, scope(), visible, options)),
		aggregate: bound(site, async <Row>(spec: AggregateSpec<Row>) => aggregateRows(context, run, scope(), context.shape, spec)),
		get: bound(site, async (id: unknown) => {
			scope()
			return selectOne(context, run, appKeyPredicate(model, id), visible)
		}),
	})
}

/** An `app` capability whose action the application table names: it reads one row with the columns of its action. */
function namedApp(context: TableContext, capability: unknown): string {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const table = context.model.name
	if (grant.kind !== 'app') {
		throw new CapabilityError('wrong_capability', `a read of ${table} here needs the capability of an app endpoint, got ${describeGrant(grant)}`)
	}
	if (!namesAction(context.model, grant.action)) {
		throw new CapabilityError(
			'wrong_action',
			`${table} does not name the action '${grant.action}': read it from an app endpoint whose action ${table} names`,
		)
	}
	return grant.action
}

/**
 * An application table under an `app` capability: listed, counted and aggregated with its read action; one row read
 * (and locked) with any action it names; inserted, updated and removed with that operation's action.
 */
function applicationRows(context: TableContext, site: DataSite, run: Runner, capability: unknown): object {
	const model = context.model
	const table = model.name
	const visible = model.visible
	const key = [keyOf(model)]
	const getForUpdate = site.kind === 'job'
		? refused(site, 'read_only', 'a job writes inside ctx.transaction((tx) => …): use tx.db there')
		: site.kind === 'query'
		? refused(site, 'read_only', 'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation')
		: bound(site, async (id: unknown) => {
			const scope = appKeyPredicate(model, id)
			const node = lockedSelectNode(table, visibleFor(model, namedApp(context, capability)), scope, model.dates)
			const rows = await (await run.read()).run(node, { root: 'SelectQueryNode', table, joins: {}, scope, lock: 'update' })
			const [row] = answerDays(table, model.dates, rows)
			if (row === undefined) {
				throw new NotFoundError(`${table} not found`)
			}
			return row
		})
	return freeze({
		list: bound(site, async (options?: unknown) => listRows(context, run, appListPredicate(context, capability), visible, options, key)),
		count: bound(site, async (options?: unknown) => countRows(context, run, appListPredicate(context, capability), visible, options)),
		aggregate: bound(
			site,
			async <Row>(spec: AggregateSpec<Row>) => aggregateRows(context, run, appListPredicate(context, capability), context.shape, spec),
		),
		get: bound(site, async (id: unknown) => {
			const action = namedApp(context, capability)
			return selectOne(context, run, appKeyPredicate(model, id), visibleFor(model, action))
		}),
		getForUpdate,
		insert: writing(site, 'insert', async (values: unknown) => insertIntoApplication(context, run, capability, values)),
		update: writing(site, 'update', async (id: unknown, values: unknown, ...options: unknown[]) => {
			const grant = updatingApp(context, capability)
			const changes = readValues(values, updatableBy(model, grant.action), 'update', model)
			return updateRow(context, run, { scope: appKeyPredicate(model, id) }, changes, versionArgument(context, options))
		}),
		remove: writing(site, 'remove', async (id: unknown, ...options: unknown[]) => {
			await removeRow(context, run, { scope: appRowPredicate(context, capability, id, 'delete') }, versionArgument(context, options))
		}),
	})
}

function referenceTables(parts: DataLayerParts, site: DataSite, run: Runner): object {
	const handle: Record<string, unknown> = {}
	const tables = ownKeys(parts.models)
	for (let index = 0; index < tables.length; index++) {
		const model = modelOf(parts.models, tables[index] ?? '')
		if (model?.scope.mode === 'reference') {
			const context = parts.contextOf(model.name)
			setOwn(
				handle,
				model.name,
				freeze({
					list: bound(site, async (options?: unknown) => listRows(context, run, everything(), model.visible, options, model.visible)),
					count: bound(site, async (options?: unknown) => countRows(context, run, everything(), model.visible, options)),
				}),
			)
		}
	}
	return freeze(handle)
}

function unscopedTables(parts: DataLayerParts, site: DataSite, run: Runner): object | undefined {
	const declared = ownKeys(site.unscoped)
	if (declared.length === 0) {
		return undefined
	}
	const handle: Record<string, unknown> = {}
	for (let index = 0; index < declared.length; index++) {
		const table = declared[index] ?? ''
		const mode = site.unscoped[table]
		if (table.startsWith(FRAMEWORK_PREFIX)) {
			throw new QueryRefusedError('framework_table', `${table} is a framework table; unscoped reaches only the tables of src/db/tables.ts`)
		}
		if (modelOf(parts.models, table) === undefined) {
			throw new QueryRefusedError('unknown_table', `unscoped declares ${table}, which is not a table of src/db/tables.ts`)
		}
		if (mode !== 'read' && mode !== 'write') {
			throw new QueryRefusedError('undeclared_reach', `unscoped declares ${table} as ${String(mode)}; the modes are 'read' and 'write'`)
		}
		setOwn(handle, table, unscopedRows(parts.contextOf(table), site, run, mode))
	}
	return freeze(handle)
}

/** A table outside the site's scope, declared: its scope predicate is `true`, and in `'read'` it writes nothing. */
function unscopedRows(context: TableContext, site: DataSite, run: Runner, mode: UnscopedMode): object {
	const model = context.model
	const table = model.name
	const visible = model.visible
	const keyed = model.scope.mode === 'dimension' || model.scope.mode === 'child' || model.scope.mode === 'app'
	const byKey = (id: unknown): OperationNode => {
		if (!keyed) {
			throw new QueryRefusedError('row_address', `${table} has no key; read it with list`)
		}
		if (typeof id !== 'string' || id.length === 0) {
			throw new QueryRefusedError('row_address', `a ${table} row is addressed by its ${keyOf(model)}, a non-empty string`)
		}
		return equals(table, keyOf(model), id)
	}
	const write = <A extends unknown[], R>(operation: 'insert' | 'update' | 'remove', method: (...args: A) => Promise<R>) => {
		if (mode === 'read') {
			const verb = operation === 'remove' ? 'remove' : operation
			return refused(site, 'undeclared_reach', `${table} is declared unscoped: 'read', so ${verb} needs unscoped: { ${table}: 'write' }`)
		}
		return writing(site, operation, method)
	}
	return freeze({
		list: bound(site, async (options?: unknown) => listRows(context, run, everything(), visible, options, keyed ? [keyOf(model)] : visible)),
		count: bound(site, async (options?: unknown) => countRows(context, run, everything(), visible, options)),
		aggregate: bound(site, async <Row>(spec: AggregateSpec<Row>) => aggregateRows(context, run, everything(), context.shape, spec)),
		get: bound(site, async (id: unknown) => {
			const scope = everything()
			const node = selectNode(rowState(table, [], [], 1), visible, scope, byKey(id), model.dates)
			const rows = await (await run.read()).run(node, { root: 'SelectQueryNode', table, joins: {}, scope })
			const [row] = answerDays(table, model.dates, rows)
			if (row === undefined) {
				throw new NotFoundError(`${table} not found`)
			}
			return row
		}),
		insert: write('insert', async (values: unknown) => insertUnscoped(context, run, site.principal, values)),
		update: write('update', async (id: unknown, values: unknown, ...options: unknown[]) => {
			const changes = readValues(values, model.update, 'update', model)
			return updateRow(context, run, { scope: everything(), conditions: byKey(id) }, changes, versionArgument(context, options))
		}),
		remove: write('remove', async (id: unknown, ...options: unknown[]) => {
			await removeRow(context, run, { scope: everything(), conditions: byKey(id) }, versionArgument(context, options))
		}),
	})
}

/**
 * No capability stamps an unscoped row's containment, so the caller names every containment column; the key, the
 * version and the creator stay the layer's.
 */
async function insertUnscoped(context: TableContext, run: Runner, principal: string, values: unknown): Promise<unknown> {
	const model = context.model
	if (model.scope.mode !== 'dimension' && model.scope.mode !== 'child' && model.scope.mode !== 'app') {
		throw new QueryRefusedError('read_only', `${model.name} is a ${model.scope.mode} table, which no handler writes`)
	}
	const chain: string[] = []
	for (let index = 0; index < model.chain.length; index++) {
		chain[chain.length] = model.chain[index]?.column ?? ''
	}
	const allowed = nameSet([...namesOf(model.insert), ...chain])
	const row = readValues(values, allowed, 'insert', model)
	for (let index = 0; index < chain.length; index++) {
		const name = chain[index] ?? ''
		const value = row.get(name)
		if (typeof value !== 'string' || value.length === 0) {
			throw new QueryRefusedError(
				'invalid_argument',
				`an unscoped insert into ${model.name} names its containment: ${name} (containment columns: ${chain.join(', ')})`,
			)
		}
	}
	row.set(keyOf(model), Bun.randomUUIDv7())
	if (model.version !== undefined) {
		row.set(model.version, 1)
	}
	if (model.createdBy !== undefined) {
		row.set(model.createdBy, principal)
	}
	return insertRow(context, run, row, undefined)
}

// ── Lists: keyset pages over the visible columns ──────────────────────────────────────────────────────────────────────

interface OrderColumn {
	readonly column: string
	readonly direction: 'asc' | 'desc'
}

/** The option object a list or a count takes, read through own data properties only; an unknown field is refused. */
function readOptions(options: unknown, allowed: readonly string[], what: string): Readonly<Record<string, unknown>> {
	if (options === undefined) {
		return {}
	}
	if (typeof options !== 'object' || options === null) {
		throw new QueryRefusedError('invalid_argument', `${what} takes { ${allowed.join(', ')} }`)
	}
	const fields = nameSet(allowed)
	const keys = ownNames(options)
	const read: Record<string, unknown> = {}
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const descriptor = ownDescriptor(options, key)
		if (!inSet(fields, key)) {
			throw new QueryRefusedError('invalid_argument', `${key} is not an option of ${what} (options: ${allowed.join(', ')})`)
		}
		if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
			throw new QueryRefusedError('invalid_argument', `${what}.${key} is an accessor; ${what} takes plain values`)
		}
		setOwn(read, key, descriptor.value)
	}
	return read
}

function conditionsOf(shape: TableShape, where: unknown): (Compare | Contains)[] {
	if (where === undefined) {
		return []
	}
	const conditions = parseList(where, (condition) => {
		const parts = parseList(condition, (part) => part)
		if (parts === undefined || parts.length !== 3) {
			throw new QueryRefusedError('invalid_argument', 'where takes [column, operator, value] conditions, each a plain array')
		}
		return parseCondition(shape, parts[0], parts[1], parts[2])
	})
	if (conditions === undefined) {
		throw new QueryRefusedError('invalid_argument', 'where takes a plain array of [column, operator, value] conditions')
	}
	return conditions
}

function orderOf(shape: TableShape, orderBy: unknown, tiebreak: readonly string[]): OrderColumn[] {
	const terms = orderBy === undefined ? [] : parseList(orderBy, (term): OrderColumn => {
		const parts = parseList(term, (part) => part)
		const direction = parts?.[1]
		if (parts === undefined || parts.length !== 2 || (direction !== 'asc' && direction !== 'desc')) {
			throw new QueryRefusedError('list_page', "orderBy takes [column, 'asc' | 'desc'] terms, each a plain array")
		}
		return { column: columnOf(shape, parts[0]), direction }
	})
	if (terms === undefined) {
		throw new QueryRefusedError('list_page', "orderBy takes a plain array of [column, 'asc' | 'desc'] terms")
	}
	const order = [...terms]
	const named = nameSet(terms.map((term) => term.column))
	for (let index = 0; index < tiebreak.length; index++) {
		// The tiebreak is held to the capability's columns like the caller's terms: a page never orders by a hidden one.
		const name = columnOf(shape, tiebreak[index])
		if (!inSet(named, name)) {
			order[order.length] = { column: name, direction: 'asc' }
		}
	}
	return order
}

function limitOf(limit: unknown): number {
	if (limit === undefined) {
		return DEFAULT_LIST_LIMIT
	}
	if (typeof limit !== 'number' || !isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
		throw new QueryRefusedError('list_page', `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`)
	}
	return limit
}

function rowState(table: string, conditions: readonly (Compare | Contains)[], order: readonly OrderColumn[], limit: number | undefined): SelectState {
	return { origin: freeze({}), table, columns: undefined, conditions, orderBy: order, limit, offset: undefined, joins: [] }
}

/** An order column's value as the database prints it: exact, where a `Date` would drop microseconds. */
type CursorValue = string | null

/** A page's position: the text of its last row's order columns (`keyset.c<n>`), as opaque text. */
function encodeCursor(row: Readonly<Record<string, unknown>>, order: readonly OrderColumn[]): string {
	const values: CursorValue[] = order.map(({ column: name }, index) => {
		const value = hasOwn(row, cursorAlias(index)) ? row[cursorAlias(index)] : null
		if (typeof value === 'string' || value === null) {
			return value
		}
		throw new QueryRefusedError('list_page', `${name} came back as ${typeof value} text, which a list cannot page by`)
	})
	return Buffer.from(JSON.stringify(values)).toString('base64url')
}

/** A row as the caller sees it: the position columns stay the layer's. */
function withoutCursor(row: Readonly<Record<string, unknown>>, order: readonly OrderColumn[]): Readonly<Record<string, unknown>> {
	const item: Record<string, unknown> = {}
	const keys = ownKeys(row)
	const cursor = nameSet(order.map((_term, index) => cursorAlias(index)))
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		if (!inSet(cursor, key)) {
			setOwn(item, key, row[key])
		}
	}
	return item
}

/** The cursor `after` names, parsed at the boundary: one plain value per order column. */
function decodeCursor(after: unknown, order: readonly OrderColumn[]): readonly CursorValue[] {
	const refused = () => new QueryRefusedError('list_page', 'after takes the next cursor of a page of this same list')
	if (typeof after !== 'string' || after.length === 0) {
		throw refused()
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'))
	} catch {
		throw refused()
	}
	const values = parseList(parsed, (value): CursorValue => {
		if (typeof value === 'string' || value === null) {
			return value
		}
		throw refused()
	})
	if (values === undefined || values.length !== order.length) {
		throw refused()
	}
	return values
}

function compare(table: string, name: string, operator: '>' | '<' | '=', value: Primitive): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create(operator), ValueNode.create(value))
}

function isNull(table: string, name: string, negated: boolean): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create(negated ? 'is not' : 'is'), ValueNode.createImmediate(null))
}

/** Rows after `value` in one order column, where Postgres sorts nulls last ascending and first descending. */
function after(table: string, order: OrderColumn, value: CursorValue): OperationNode | undefined {
	if (order.direction === 'asc') {
		return value === null ? undefined : anyOf([compare(table, order.column, '>', value), isNull(table, order.column, false)])
	}
	return value === null ? isNull(table, order.column, true) : compare(table, order.column, '<', value)
}

/** `(c1 after v1) or (c1 = v1 and c2 after v2) or …`: every row the order puts after the cursor's. */
function keysetAfter(table: string, order: readonly OrderColumn[], values: readonly CursorValue[]): OperationNode {
	const branches: OperationNode[] = []
	for (let index = 0; index < order.length; index++) {
		const term = order[index]
		const position = term === undefined ? undefined : after(table, term, values[index] ?? null)
		if (term === undefined || position === undefined) {
			continue
		}
		const equal: OperationNode[] = []
		for (let previous = 0; previous < index; previous++) {
			const name = order[previous]?.column ?? ''
			const value = values[previous] ?? null
			equal[equal.length] = value === null ? isNull(table, name, false) : compare(table, name, '=', value)
		}
		branches[branches.length] = equal.length === 0 ? position : allOf([...equal, position])
	}
	return branches.length === 0 ? ValueNode.createImmediate(false) : anyOf(branches)
}

/** One keyset page: `limit` rows in the order asked, the tiebreak columns last, and the cursor of the next page. */
async function listRows(
	context: TableContext,
	run: Runner,
	scope: OperationNode | undefined,
	visible: readonly string[],
	input: unknown,
	tiebreak: readonly string[],
): Promise<{ readonly items: Readonly<Record<string, unknown>>[]; readonly next: string | null }> {
	const table = context.model.name
	const options = readOptions(input, ['where', 'orderBy', 'limit', 'after'], 'list')
	const shape = actionShape(context.model, visible)
	const conditions = conditionsOf(shape, options['where'])
	const order = orderOf(shape, options['orderBy'], tiebreak)
	const limit = limitOf(options['limit'])
	const position = options['after'] === undefined ? undefined : keysetAfter(table, order, decodeCursor(options['after'], order))
	if (scope === undefined) {
		return { items: [], next: null }
	}
	const node = withCursorColumns(
		selectNode(rowState(table, conditions, order, limit + 1), visible, scope, position, context.model.dates),
		table,
		order.map((term) => term.column),
	)
	const rows = await (await run.read()).run<Readonly<Record<string, unknown>>>(node, {
		root: 'SelectQueryNode',
		table,
		joins: {},
		scope,
	})
	const page = answerDays(table, context.model.dates, rows.slice(0, limit))
	const last = page[page.length - 1]
	return {
		items: page.map((row) => withoutCursor(row, order)),
		next: rows.length > limit && last !== undefined ? encodeCursor(last, order) : null,
	}
}

async function countRows(
	context: TableContext,
	run: Runner,
	scope: OperationNode | undefined,
	visible: readonly string[],
	input: unknown,
): Promise<number> {
	const table = context.model.name
	const options = readOptions(input, ['where'], 'count')
	const conditions = conditionsOf(actionShape(context.model, visible), options['where'])
	if (scope === undefined) {
		return 0
	}
	const node = aggregateNode(table, { groupBy: [], count: true, sum: [], min: [], max: [] }, conditions, scope)
	const [row] = await (await run.read()).run<Readonly<Record<string, unknown>>>(node, { root: 'SelectQueryNode', table, joins: {}, scope })
	const count = row === undefined ? '0' : row['count']
	return typeof count === 'string' || typeof count === 'number' ? Number(count) : 0
}
