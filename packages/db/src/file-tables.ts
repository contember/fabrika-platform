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
	ParensNode,
	SelectAllNode,
	SelectionNode,
	type SelectQueryNode,
	TableNode,
	ValueNode,
} from 'kysely'
import { freeze, ownEntry } from './builtins'
import type { RefGrant } from './capability'
import { type Session, sessionOf } from './database'
import { CapabilityError, NotFoundError, PolicyError, QueryRefusedError } from './errors'
import { FILE_COLUMNS, tableOf } from './file-table-sql'
import type { GuardContext } from './guard'
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
}

export interface PendingFile {
	readonly id: string
	readonly objectKey: string
	readonly contentType: string
	readonly originalName: string | null
	readonly createdAt: Date
}

export interface LiveFile {
	readonly id: string
	readonly objectKey: string
	readonly size: number
	readonly contentType: string
	readonly originalName: string | null
}

/** A row whose object may be deleted: removed, orphaned by its owner's deletion, or pending past the grace period. */
export interface RemovableFile {
	readonly id: string
	readonly objectKey: string
}

export interface FileCollectionTable {
	/** Locks the owner where `owner` says it lies and inserts a `pending` row there: the intent to clean its object up. */
	begin(owner: unknown, file: PendingFile): Promise<void>
	/** Locks the owner again and makes the pending row `live`; `NotFoundError` when the owner moved or the row is gone. */
	complete(owner: unknown, id: string, written: { readonly size: number; readonly sha256: string }): Promise<void>
	/** Deletes the caller's own pending row once its object is gone. */
	abandon(id: string): Promise<void>
	countLive(owner: unknown): Promise<number>
	/** Marks a live file of `owner` removed. */
	retract(owner: unknown, id: string, at: Date): Promise<void>
	/** The live file `file` names, over its whole chain; `NotFoundError` otherwise. */
	find(file: unknown): Promise<LiveFile>
	markRemoved(file: unknown, at: Date): Promise<void>
	/** The containers of a live file, read from its row: its owner and the owner's chain. */
	locate(id: string): Promise<ReadonlyMap<string, string> | null>
	/** At most `limit` rows whose objects may be deleted; a pending row only when created before `pendingBefore`. */
	removable(limit: number, pendingBefore: Date): Promise<readonly RemovableFile[]>
	/** Deletes the row of a removable file; a live file's row, and a recent pending one, are never deleted. */
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

function compare(table: string, name: string, operator: '=' | '<', value: string | Date): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create(operator), ValueNode.create(value))
}

function selectNode(
	table: string,
	selections: readonly SelectionNode[],
	conditions: OperationNode,
	scope: OperationNode,
	limit?: number,
): SelectQueryNode {
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections,
		where: scopedWhere(conditions, scope),
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
		throw new QueryRefusedError(`${table}.${name} came back as ${typeof value}`)
	}
	return value
}

/** BIGINT and `count` come back as strings. */
function integer(table: string, row: Readonly<Record<string, unknown>>, name: string): number {
	const value = Number(ownEntry(row, name))
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError(`${table}.${name} is not a non-negative integer`)
	}
	return value
}

const LIVE_COLUMNS = ['id', 'object_key', 'size', 'content_type', 'original_name']

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
				`files '${spec.name}' needs a Ref of ${dimension} for ${action}, got a ${grant.kind} of ${grant.dimension} for ${grant.action}`,
			)
		}
		return grant
	}

	const live = (): OperationNode => allOf([compare(table, 'status', '=', 'live'), isNull(table, 'deleted_at', false), isNull(table, 'owner_id', true)])

	/** Removed or orphaned live files, and pending rows older than `pendingBefore`; never an upload in progress. */
	const removable = (pendingBefore: Date): OperationNode =>
		anyOf([
			ParensNode.create(
				allOf([compare(table, 'status', '=', 'live'), ParensNode.create(anyOf([isNull(table, 'deleted_at', true), isNull(table, 'owner_id', false)]))]),
			),
			ParensNode.create(allOf([compare(table, 'status', '=', 'pending'), compare(table, 'created_at', '<', pendingBefore)])),
		])

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

		async complete(capability: unknown, id: string, written: { readonly size: number; readonly sha256: string }): Promise<void> {
			const grant = grantOf(capability, owner.dimension, spec.actions.write)
			const scope = ownedFile(grant, id)
			const pending = allOf([compare(table, 'status', '=', 'pending'), isNull(table, 'deleted_at', false)])
			const changes = new Map<string, string | number>([['status', 'live'], ['size', written.size], ['sha256', written.sha256]])
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

		async countLive(capability: unknown): Promise<number> {
			const grant = grantOf(capability, owner.dimension, spec.actions.write)
			const scope = linksPredicate(table, linkValues(table, fileOwnerLinks, grant))
			const count = SelectionNode.create(
				AliasNode.create(AggregateFunctionNode.create('count', [SelectAllNode.create()]), IdentifierNode.create('count')),
			)
			const conditions = allOf([compare(table, 'status', '=', 'live'), isNull(table, 'deleted_at', false)])
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
				scopedWhere(live(), scope),
				acknowledgement(table, 'id', undefined),
			)
			await session().run(node, guard('UpdateQueryNode', table, scope))
		},

		async find(capability: unknown): Promise<LiveFile> {
			const grant = grantOf(capability, spec.dimension, spec.actions.read)
			const scope = linksPredicate(table, linkValues(table, fileLinks, grant))
			const [row] = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, LIVE_COLUMNS), live(), scope, 1),
				guard('SelectQueryNode', table, scope),
			)
			if (row === undefined) {
				throw new NotFoundError(`files '${spec.name}': the file is not where its Ref says`)
			}
			const originalName = ownEntry(row, 'original_name')
			return freeze({
				id: text(table, row, 'id'),
				objectKey: text(table, row, 'object_key'),
				size: integer(table, row, 'size'),
				contentType: text(table, row, 'content_type'),
				originalName: typeof originalName === 'string' ? originalName : null,
			})
		},

		async markRemoved(capability: unknown, at: Date): Promise<void> {
			const grant = grantOf(capability, spec.dimension, spec.actions.delete)
			const scope = linksPredicate(table, linkValues(table, fileLinks, grant))
			const node = updateNode(
				table,
				new Map([['deleted_at', at]]),
				undefined,
				scopedWhere(live(), scope),
				acknowledgement(table, 'id', undefined),
			)
			const updated = await session().run(node, guard('UpdateQueryNode', table, scope))
			if (updated.length === 0) {
				throw new NotFoundError(`files '${spec.name}': the file is not where its Ref says`)
			}
		},

		async locate(id: string): Promise<ReadonlyMap<string, string> | null> {
			const scope = equals(table, 'id', id)
			const columns = fileOwnerLinks.map((link) => link.column)
			const [row] = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, columns), live(), scope, 1),
				guard('SelectQueryNode', table, scope),
			)
			if (row === undefined) {
				return null
			}
			return new Map(fileOwnerLinks.map((link) => [link.dimension, text(table, row, link.column)]))
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
