// The framework's side of a file collection's table (`fabrika_files_<collection>`): the rows `@fabrika/app`'s files
// runtime writes and reads. No store reaches these tables, and codegen leaves them out. Every operation a request
// makes takes the request's capability and carries its whole containment chain as the scope predicate, exactly as a
// store's does, so a capability minted before its owner moved matches nothing.

import {
	AggregateFunctionNode,
	AliasNode,
	BinaryOperationNode,
	FromNode,
	IdentifierNode,
	LimitNode,
	type OperationNode,
	OperatorNode,
	OrderByItemNode,
	OrderByNode,
	ParensNode,
	RawNode,
	SelectAllNode,
	SelectionNode,
	type SelectQueryNode,
	TableNode,
	ValueNode,
} from 'kysely'
import { freeze, ownEntry } from './builtins'
import { describeGrant, type RefGrant } from './capability'
import { type Session, sessionOf } from './database'
import { CapabilityError, NotFoundError, PolicyError, QueryRefusedError } from './errors'
import { FILE_COLUMNS, type FileStatus, tableOf } from './file-table-sql'
import type { GuardContext } from './guard'
import { fencedTransaction } from './job-leases'
import { linksPredicate, linkValues } from './links'
import { acknowledgement, allOf, anyOf, column, deleteNode, equals, everything, insertNode, lockNode, scopedWhere, updateNode } from './nodes'
import { type Container, modelOf, type TableModel, type TableModels } from './policy'
import type { DataLayerRuntime } from './store'

/** What `@fabrika/app` declares of one collection: its owner table, its dimension and its three actions. */
export interface FileCollectionSpec {
	readonly name: string
	readonly owner: string
	/** `file:<name>`, contained in the owner's dimension. */
	readonly dimension: string
	readonly actions: { readonly read: string; readonly write: string; readonly delete: string }
	/** Whether the collection scans its uploads: only then does its table carry the scan columns. */
	readonly scan: boolean
}

export interface PendingFile {
	readonly id: string
	readonly objectKey: string
	readonly contentType: string
	readonly originalName: string | null
	readonly createdAt: Date
}

/** A file whose upload completed: served when `live`, `409` while `quarantined`, gone when `rejected`. */
export type HeldStatus = Exclude<FileStatus, 'pending'>

export interface StoredFile {
	readonly id: string
	readonly objectKey: string
	readonly size: number
	readonly contentType: string
	readonly originalName: string | null
	readonly status: HeldStatus
	/** The object version a scanning collection's file was scanned as; `null` before a verdict or without scanning. */
	readonly objectVersion: string | null
}

/** One row of an owner's file list. */
export interface ListedFile {
	readonly id: string
	readonly name: string | null
	readonly type: string
	readonly size: number
	readonly status: HeldStatus
	readonly createdAt: Date
}

/** A keyset page of an owner's files, oldest first; `next` is the `after` of the following page. */
export interface FilePage {
	readonly items: readonly ListedFile[]
	readonly next: string | null
}

/** What the scan pass needs of a quarantined file: its object, the size and digest its upload recorded, its tries. */
export interface QuarantinedFile {
	readonly id: string
	readonly objectKey: string
	readonly size: number
	readonly sha256: string
	readonly contentType: string
	/** Earlier passes that gave it no verdict, or whose rejection could not delete its object. */
	readonly scanAttempts: number
	/** Since when it waits: its quarantine, or the end of its last retry's wait. Oldest first, across collections. */
	readonly dueSince: Date
}

/** A row whose object may be deleted: removed, orphaned by its owner's deletion, or pending past the grace period. */
export interface RemovableFile {
	readonly id: string
	readonly objectKey: string
}

export interface FileCollectionTable {
	/** Locks the owner where `owner` says it lies and inserts a `pending` row there: the intent to clean its object up. */
	begin(owner: unknown, file: PendingFile): Promise<void>
	/**
	 * Locks the owner again and ends the pending row in `status`: `live`, or `quarantined` in a scanning collection;
	 * `NotFoundError` when the owner moved or the row is gone.
	 */
	complete(owner: unknown, id: string, written: { readonly size: number; readonly sha256: string }, status: 'live' | 'quarantined'): Promise<void>
	/** Deletes the caller's own pending row once its object is gone. */
	abandon(id: string): Promise<void>
	/** The owner's files that hold a place in its quota: live, quarantined and rejected, until removed. */
	countHeld(owner: unknown): Promise<number>
	/** Marks a held file of `owner` removed. */
	retract(owner: unknown, id: string, at: Date): Promise<void>
	/**
	 * The held file `file` names, over its whole chain, in any held state; `NotFoundError` otherwise. `using` is the
	 * session of the site that reads it (a handler's invocation, a job's transaction); the request's own by default.
	 */
	find(file: unknown, using?: Session): Promise<StoredFile>
	/** Marks the held file `file` names removed, in any held state. */
	markRemoved(file: unknown, at: Date): Promise<void>
	/**
	 * Marks every file of the owner `owner` (a `Ref` for the delete action) removed, in `using`, held files and pending
	 * uploads alike: an upload begun before the removal then fails its completion and cleans up. Answers how many.
	 */
	removeOwned(owner: unknown, at: Date, using: Session): Promise<number>
	/** The containers of a held file, read from its row: its owner and the owner's chain. */
	locate(id: string, using?: Session): Promise<ReadonlyMap<string, string> | null>
	/** At most `limit` held files of the owner `owner` (a `Ref` for the read action) after the id `after`, oldest first. */
	list(owner: unknown, page: { readonly after: string | null; readonly limit: number }, using?: Session): Promise<FilePage>
	/**
	 * At most `limit` quarantined files that are neither removed nor orphaned and due at `now`, the longest waiting
	 * first, so neither files that keep failing nor a busy collection hold back the rest.
	 */
	quarantined(limit: number, now: Date): Promise<readonly QuarantinedFile[]>
	/**
	 * Makes a quarantined file `live` when it is still quarantined, not removed, not orphaned and its recorded digest is
	 * `sha256`, and records `version`, the scanned object's. Only inside a job attempt's lease, which fences the write;
	 * `false` when no row matched.
	 */
	promote(id: string, sha256: string, version: string): Promise<boolean>
	/** Records a try that gave no verdict, the `attempts`-th, and when the next may start; fenced like `promote`. */
	deferScan(id: string, attempts: number, after: Date): Promise<boolean>
	/**
	 * Quarantines a live file of a scanning collection again, when its object is no longer the version it was scanned
	 * as (`version`, `null` for a file that went live before the collection scanned): the download that saw it.
	 */
	requarantine(file: unknown, version: string | null): Promise<void>
	/** Marks a quarantined file `rejected` once its object is deleted; fenced like `promote`. `false` when no row matched. */
	reject(id: string): Promise<boolean>
	/**
	 * At most `limit` rows whose objects may be deleted: a removed or orphaned file in any held state, and a pending row
	 * only when created before `pendingBefore`.
	 */
	removable(limit: number, pendingBefore: Date): Promise<readonly RemovableFile[]>
	/** Deletes the row of a removable file; a held file's row, and a recent pending one, are never deleted. */
	purge(id: string, pendingBefore: Date): Promise<void>
}

export interface FileTables {
	/** The table of one collection; throws `PolicyError` when its owner is not a dimension table it can carry. */
	collection(spec: FileCollectionSpec): FileCollectionTable
}

interface Owner {
	readonly model: TableModel
	readonly dimension: string
	readonly key: string
}

function ownerOf(models: TableModels, spec: FileCollectionSpec): Owner {
	const model = modelOf(models, spec.owner)
	if (model === undefined || model.scope.mode !== 'dimension') {
		throw new PolicyError(`files '${spec.name}': its owner ${spec.owner} is not a dimension table`)
	}
	for (const link of model.chain) {
		if (FILE_COLUMNS.includes(link.column)) {
			throw new PolicyError(`files '${spec.name}': the owner column ${link.column} has the name of a file column`)
		}
	}
	return { model, dimension: model.scope.dimension, key: model.scope.key }
}

function isNull(table: string, name: string, negated: boolean): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create(negated ? 'is not' : 'is'), ValueNode.createImmediate(null))
}

function compare(table: string, name: string, operator: '=' | '<' | '>', value: string | number | Date): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create(operator), ValueNode.create(value))
}

function selectNode(
	table: string,
	selections: readonly SelectionNode[],
	conditions: OperationNode,
	scope: OperationNode,
	limit?: number,
	orderBy: readonly string[] = [],
): SelectQueryNode {
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections,
		where: scopedWhere(conditions, scope),
		orderBy: orderBy.length === 0
			? undefined
			: OrderByNode.create(orderBy.map((name) => OrderByItemNode.create(column(table, name), RawNode.createWithSql('asc')))),
		limit: limit === undefined ? undefined : LimitNode.create(ValueNode.create(limit)),
	}
	return freeze(node)
}

function selections(table: string, names: readonly string[]): SelectionNode[] {
	return names.map((name) => SelectionNode.create(column(table, name)))
}

function guard(root: GuardContext['root'], table: string, scope: OperationNode | undefined, lock?: 'share'): GuardContext {
	return lock === undefined ? { root, table, joins: {}, scope } : { root, table, joins: {}, scope, lock }
}

function text(table: string, row: Readonly<Record<string, unknown>>, name: string): string {
	const value = ownEntry(row, name)
	if (typeof value !== 'string') {
		throw new QueryRefusedError('unexpected_row', `${table}.${name} came back as ${typeof value}`)
	}
	return value
}

/** BIGINT and `count` come back as strings. */
function integer(table: string, row: Readonly<Record<string, unknown>>, name: string): number {
	const value = Number(ownEntry(row, name))
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError('unexpected_row', `${table}.${name} is not a non-negative integer`)
	}
	return value
}

const STORED_COLUMNS = ['id', 'object_key', 'size', 'content_type', 'original_name', 'status']
const SCANNED_COLUMNS = [...STORED_COLUMNS, 'object_version']
const LISTED_COLUMNS = ['id', 'original_name', 'content_type', 'size', 'status', 'created_at']
const HELD: readonly HeldStatus[] = ['live', 'quarantined', 'rejected']

function heldStatus(table: string, row: Readonly<Record<string, unknown>>): HeldStatus {
	const status = ownEntry(row, 'status')
	const held = HELD.find((candidate) => candidate === status)
	if (held === undefined) {
		throw new QueryRefusedError('unexpected_row', `${table}.status came back as a state no held file has`)
	}
	return held
}

function nullableText(row: Readonly<Record<string, unknown>>, name: string): string | null {
	const value = ownEntry(row, name)
	return typeof value === 'string' ? value : null
}

function date(table: string, row: Readonly<Record<string, unknown>>, name: string): Date {
	const value = ownEntry(row, name)
	if (!(value instanceof Date)) {
		throw new QueryRefusedError('unexpected_row', `${table}.${name} came back as ${typeof value}`)
	}
	return value
}

function collectionTable(models: TableModels, runtime: () => DataLayerRuntime, spec: FileCollectionSpec): FileCollectionTable {
	const table = tableOf(spec.name)
	const owner = ownerOf(models, spec)
	/** The owner row itself: its key, then its chain. */
	const ownerLinks: readonly Container[] = [{ dimension: owner.dimension, column: owner.key }, ...owner.model.chain]
	/** A file row's columns for its owner: `owner_id`, then the owner's chain under the owner's column names. */
	const fileOwnerLinks: readonly Container[] = [{ dimension: owner.dimension, column: 'owner_id' }, ...owner.model.chain]
	const fileLinks: readonly Container[] = [{ dimension: spec.dimension, column: 'id' }, ...fileOwnerLinks]
	const session = (): Session => sessionOf(runtime())

	function grantOf(capability: unknown, dimension: string, action: string): RefGrant {
		const grant = runtime().capabilities.resolve(capability)
		if (grant.kind !== 'ref' || grant.dimension !== dimension || grant.action !== action) {
			throw new CapabilityError(
				'wrong_capability',
				`files '${spec.name}' needs a Ref of ${dimension} for ${action}, got ${describeGrant(grant)} for ${grant.action}`,
			)
		}
		return grant
	}

	const isHeld = (): OperationNode => anyOf(HELD.map((status) => compare(table, 'status', '=', status)))
	const status = (value: HeldStatus): OperationNode => compare(table, 'status', '=', value)
	/** A held file that is neither removed nor orphaned: one a request may reach. */
	const held = (state: OperationNode = isHeld()): OperationNode => allOf([state, isNull(table, 'deleted_at', false), isNull(table, 'owner_id', true)])

	/** Removed or orphaned files in every held state, and pending rows older than `pendingBefore`; never an upload in progress. */
	const removable = (pendingBefore: Date): OperationNode =>
		anyOf([
			ParensNode.create(allOf([isHeld(), anyOf([isNull(table, 'deleted_at', true), isNull(table, 'owner_id', false)])])),
			ParensNode.create(allOf([compare(table, 'status', '=', 'pending'), compare(table, 'created_at', '<', pendingBefore)])),
		])

	/** A verdict of the scan pass: one conditional update, fenced by the attempt's lease. */
	function scanning(operation: string): void {
		if (!spec.scan) {
			throw new QueryRefusedError('file_scan', `files '${spec.name}' does not scan; it has no ${operation}`)
		}
	}

	async function verdict(id: string, changes: ReadonlyMap<string, string | number | Date | null>, conditions: OperationNode): Promise<boolean> {
		const current = runtime()
		const fence = current.capabilities.fence()
		if (fence === null) {
			throw new QueryRefusedError('file_scan', `files '${spec.name}': a scan verdict is written only inside the scan job's lease`)
		}
		const scope = equals(table, 'id', id)
		const node = updateNode(table, changes, undefined, scopedWhere(conditions, scope), acknowledgement(table, 'id', undefined))
		const updated = await fencedTransaction(sessionOf(current), fence, (transaction) => transaction.run(node, guard('UpdateQueryNode', table, scope)))
		return updated.length > 0
	}

	/** Locks the owner row `for share` where the Ref says it lies, in `transaction`; `NotFoundError` when it does not. */
	async function lockOwner(transaction: Session, grant: RefGrant): Promise<void> {
		const name = owner.model.name
		const scope = linksPredicate(name, linkValues(name, ownerLinks, grant))
		const rows = await transaction.run(lockNode(name, owner.key, scope), guard('SelectQueryNode', name, scope, 'share'))
		if (rows.length === 0) {
			throw new NotFoundError(`${name} ${grant.id} is not where its Ref says; obtain a fresh Ref`)
		}
	}

	function ownedFile(grant: RefGrant, id: string): OperationNode {
		return allOf([equals(table, 'id', id), linksPredicate(table, linkValues(table, fileOwnerLinks, grant))])
	}

	return freeze({
		async begin(capability: unknown, file: PendingFile): Promise<void> {
			const grant = grantOf(capability, owner.dimension, spec.actions.write)
			const values = new Map<string, string | Date | null>([['id', file.id]])
			for (const { link, value } of linkValues(table, fileOwnerLinks, grant)) {
				values.set(link.column, value)
			}
			values.set('status', 'pending')
			values.set('object_key', file.objectKey)
			values.set('content_type', file.contentType)
			values.set('original_name', file.originalName)
			values.set('created_by', grant.principal)
			values.set('created_at', file.createdAt)
			await session().transaction(async (transaction) => {
				await lockOwner(transaction, grant)
				await transaction.run(insertNode(table, values, acknowledgement(table, 'id', undefined)), guard('InsertQueryNode', table, undefined))
			})
		},

		async complete(
			capability: unknown,
			id: string,
			written: { readonly size: number; readonly sha256: string },
			ended: 'live' | 'quarantined',
		): Promise<void> {
			const grant = grantOf(capability, owner.dimension, spec.actions.write)
			const scope = ownedFile(grant, id)
			const pending = allOf([compare(table, 'status', '=', 'pending'), isNull(table, 'deleted_at', false)])
			const changes = new Map<string, string | number | Date>([['status', ended], ['size', written.size], ['sha256', written.sha256]])
			if (ended === 'quarantined') {
				scanning('quarantine')
				changes.set('scan_after', new Date())
			}
			const node = updateNode(table, changes, undefined, scopedWhere(pending, scope), acknowledgement(table, 'id', undefined))
			await session().transaction(async (transaction) => {
				await lockOwner(transaction, grant)
				const updated = await transaction.run(node, guard('UpdateQueryNode', table, scope))
				if (updated.length === 0) {
					throw new NotFoundError(`the pending file ${id} is no longer where its owner's Ref says`)
				}
			})
		},

		async abandon(id: string): Promise<void> {
			const scope = equals(table, 'id', id)
			const where = scopedWhere(compare(table, 'status', '=', 'pending'), scope)
			await session().run(deleteNode(table, where, 'id'), guard('DeleteQueryNode', table, scope))
		},

		async countHeld(capability: unknown): Promise<number> {
			const grant = grantOf(capability, owner.dimension, spec.actions.write)
			const scope = linksPredicate(table, linkValues(table, fileOwnerLinks, grant))
			const count = SelectionNode.create(
				AliasNode.create(AggregateFunctionNode.create('count', [SelectAllNode.create()]), IdentifierNode.create('count')),
			)
			const conditions = allOf([isHeld(), isNull(table, 'deleted_at', false)])
			const [row] = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, [count], conditions, scope),
				guard('SelectQueryNode', table, scope),
			)
			return row === undefined ? 0 : integer(table, row, 'count')
		},

		async retract(capability: unknown, id: string, at: Date): Promise<void> {
			const grant = grantOf(capability, owner.dimension, spec.actions.write)
			const scope = ownedFile(grant, id)
			const node = updateNode(
				table,
				new Map([['deleted_at', at]]),
				undefined,
				scopedWhere(held(), scope),
				acknowledgement(table, 'id', undefined),
			)
			await session().run(node, guard('UpdateQueryNode', table, scope))
		},

		async find(capability: unknown, using?: Session): Promise<StoredFile> {
			const grant = grantOf(capability, spec.dimension, spec.actions.read)
			const scope = linksPredicate(table, linkValues(table, fileLinks, grant))
			const [row] = await (using ?? session()).run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, spec.scan ? SCANNED_COLUMNS : STORED_COLUMNS), held(), scope, 1),
				guard('SelectQueryNode', table, scope),
			)
			if (row === undefined) {
				throw new NotFoundError(`files '${spec.name}': the file is not where its Ref says`)
			}
			return freeze({
				id: text(table, row, 'id'),
				objectKey: text(table, row, 'object_key'),
				size: integer(table, row, 'size'),
				contentType: text(table, row, 'content_type'),
				originalName: nullableText(row, 'original_name'),
				status: heldStatus(table, row),
				objectVersion: spec.scan ? nullableText(row, 'object_version') : null,
			})
		},

		async markRemoved(capability: unknown, at: Date): Promise<void> {
			const grant = grantOf(capability, spec.dimension, spec.actions.delete)
			const scope = linksPredicate(table, linkValues(table, fileLinks, grant))
			const node = updateNode(
				table,
				new Map([['deleted_at', at]]),
				undefined,
				scopedWhere(held(), scope),
				acknowledgement(table, 'id', undefined),
			)
			const updated = await session().run(node, guard('UpdateQueryNode', table, scope))
			if (updated.length === 0) {
				throw new NotFoundError(`files '${spec.name}': the file is not where its Ref says`)
			}
		},

		async removeOwned(capability: unknown, at: Date, using: Session): Promise<number> {
			const grant = grantOf(capability, owner.dimension, spec.actions.delete)
			const scope = linksPredicate(table, linkValues(table, fileOwnerLinks, grant))
			const node = updateNode(
				table,
				new Map([['deleted_at', at]]),
				undefined,
				scopedWhere(held(anyOf([isHeld(), compare(table, 'status', '=', 'pending')])), scope),
				acknowledgement(table, 'id', undefined),
			)
			const removed = await using.run(node, guard('UpdateQueryNode', table, scope))
			return removed.length
		},

		async locate(id: string, using?: Session): Promise<ReadonlyMap<string, string> | null> {
			const scope = equals(table, 'id', id)
			const columns = fileOwnerLinks.map((link) => link.column)
			const [row] = await (using ?? session()).run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, columns), held(), scope, 1),
				guard('SelectQueryNode', table, scope),
			)
			if (row === undefined) {
				return null
			}
			return new Map(fileOwnerLinks.map((link) => [link.dimension, text(table, row, link.column)]))
		},

		async list(capability: unknown, page: { readonly after: string | null; readonly limit: number }, using?: Session): Promise<FilePage> {
			const grant = grantOf(capability, owner.dimension, spec.actions.read)
			if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
				throw new QueryRefusedError('list_page', `files '${spec.name}': a page holds at least one file`)
			}
			const scope = linksPredicate(table, linkValues(table, fileOwnerLinks, grant))
			const conditions = page.after === null ? held() : allOf([held(), compare(table, 'id', '>', page.after)])
			const rows = await (using ?? session()).run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, LISTED_COLUMNS), conditions, scope, page.limit + 1, ['id']),
				guard('SelectQueryNode', table, scope),
			)
			const items = rows.slice(0, page.limit).map((row) =>
				freeze({
					id: text(table, row, 'id'),
					name: nullableText(row, 'original_name'),
					type: text(table, row, 'content_type'),
					size: integer(table, row, 'size'),
					status: heldStatus(table, row),
					createdAt: date(table, row, 'created_at'),
				})
			)
			const last = items[items.length - 1]
			return freeze({ items, next: rows.length > page.limit && last !== undefined ? last.id : null })
		},

		async quarantined(limit: number, now: Date): Promise<readonly QuarantinedFile[]> {
			scanning('scan batch')
			const scope = everything()
			const due = allOf([held(status('quarantined')), anyOf([isNull(table, 'scan_after', false), compare(table, 'scan_after', '<', now)])])
			const columns = ['id', 'object_key', 'size', 'sha256', 'content_type', 'scan_attempts', 'scan_after', 'created_at']
			const rows = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, columns), due, scope, limit, ['scan_after', 'created_at']),
				guard('SelectQueryNode', table, scope),
			)
			return rows.map((row) =>
				freeze({
					id: text(table, row, 'id'),
					objectKey: text(table, row, 'object_key'),
					size: integer(table, row, 'size'),
					sha256: text(table, row, 'sha256'),
					contentType: text(table, row, 'content_type'),
					scanAttempts: integer(table, row, 'scan_attempts'),
					dueSince: ownEntry(row, 'scan_after') instanceof Date ? date(table, row, 'scan_after') : date(table, row, 'created_at'),
				})
			)
		},

		async promote(id: string, sha256: string, version: string): Promise<boolean> {
			scanning('verdict')
			const changes = new Map([['status', 'live'], ['object_version', version]])
			return await verdict(id, changes, allOf([held(status('quarantined')), compare(table, 'sha256', '=', sha256)]))
		},

		async deferScan(id: string, attempts: number, after: Date): Promise<boolean> {
			scanning('retry')
			const changes = new Map<string, number | Date>([['scan_attempts', attempts], ['scan_after', after]])
			return await verdict(id, changes, allOf([status('quarantined'), compare(table, 'scan_attempts', '=', attempts - 1)]))
		},

		async requarantine(capability: unknown, version: string | null): Promise<void> {
			scanning('quarantine')
			const grant = grantOf(capability, spec.dimension, spec.actions.read)
			const scope = linksPredicate(table, linkValues(table, fileLinks, grant))
			const scanned = version === null ? isNull(table, 'object_version', false) : compare(table, 'object_version', '=', version)
			const changes = new Map<string, string | number | Date | null>([
				['status', 'quarantined'],
				['object_version', null],
				['scan_attempts', 0],
				['scan_after', new Date()],
			])
			const node = updateNode(
				table,
				changes,
				undefined,
				scopedWhere(allOf([held(status('live')), scanned]), scope),
				acknowledgement(table, 'id', undefined),
			)
			await session().run(node, guard('UpdateQueryNode', table, scope))
		},

		reject(id: string): Promise<boolean> {
			return verdict(id, new Map([['status', 'rejected']]), status('quarantined'))
		},

		async removable(limit: number, pendingBefore: Date): Promise<readonly RemovableFile[]> {
			const scope = everything()
			const rows = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, ['id', 'object_key']), removable(pendingBefore), scope, limit),
				guard('SelectQueryNode', table, scope),
			)
			return rows.map((row) => freeze({ id: text(table, row, 'id'), objectKey: text(table, row, 'object_key') }))
		},

		async purge(id: string, pendingBefore: Date): Promise<void> {
			const scope = equals(table, 'id', id)
			await session().run(deleteNode(table, scopedWhere(removable(pendingBefore), scope), 'id'), guard('DeleteQueryNode', table, scope))
		},
	})
}

export function fileTables(models: TableModels, runtime: () => DataLayerRuntime): FileTables {
	return freeze({ collection: (spec: FileCollectionSpec) => collectionTable(models, runtime, spec) })
}
