// The framework's side of a file collection's table (`fabrika_files_<collection>`): the rows `@fabrika/app`'s files
// runtime writes and reads after its own access check. No store reaches these tables, and codegen leaves them out.
// Every statement is a guarded tree like a store's, keyed by equalities on the file table itself.

import {
	AggregateFunctionNode,
	AliasNode,
	BinaryOperationNode,
	FromNode,
	IdentifierNode,
	LimitNode,
	type OperationNode,
	OperatorNode,
	OrNode,
	ParensNode,
	SelectAllNode,
	SelectionNode,
	type SelectQueryNode,
	TableNode,
	ValueNode,
} from 'kysely'
import { sessionOf } from './database'
import { QueryRefusedError } from './errors'
import { tableOf } from './file-table-sql'
import type { GuardContext } from './guard'
import { acknowledgement, allOf, column, deleteNode, equals, everything, insertNode, scopedWhere, updateNode } from './nodes'
import type { DataLayerRuntime } from './store'

/** A file whose row is live: not removed, and its owner row still exists. */
export interface LiveFile {
	readonly id: string
	readonly ownerId: string
	readonly objectKey: string
	readonly size: number
	readonly contentType: string
	readonly originalName: string | null
}

export interface NewFile extends LiveFile {
	readonly sha256: string
	readonly createdBy: string
	readonly createdAt: Date
}

/** A row whose object may be deleted: removed, or orphaned because its owner row was deleted. */
export interface RemovableFile {
	readonly id: string
	readonly objectKey: string
}

export interface FileTables {
	insert(collection: string, file: NewFile): Promise<void>
	/** The live file `id`, or `null`. */
	find(collection: string, id: string): Promise<LiveFile | null>
	countLive(collection: string, ownerId: string): Promise<number>
	/** Marks a live file removed; `false` when there was none. */
	markRemoved(collection: string, id: string, at: Date): Promise<boolean>
	/** At most `limit` rows whose objects may be deleted. */
	removable(collection: string, limit: number): Promise<readonly RemovableFile[]>
	/** Deletes the row of a removable file; a live file's row is never deleted. */
	purge(collection: string, id: string): Promise<void>
}

const LIVE_COLUMNS = ['id', 'owner_id', 'object_key', 'size', 'content_type', 'original_name']

function guard(root: GuardContext['root'], table: string, scope: OperationNode | undefined): GuardContext {
	return { root, table, joins: {}, scope }
}

function isNull(table: string, name: string, negated: boolean): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create(negated ? 'is not' : 'is'), ValueNode.createImmediate(null))
}

function live(table: string): OperationNode {
	return allOf([isNull(table, 'deleted_at', false), isNull(table, 'owner_id', true)])
}

function removed(table: string): OperationNode {
	return ParensNode.create(OrNode.create(isNull(table, 'deleted_at', true), isNull(table, 'owner_id', false)))
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
	return Object.freeze(node)
}

function selections(table: string, names: readonly string[]): SelectionNode[] {
	return names.map((name) => SelectionNode.create(column(table, name)))
}

function text(table: string, row: Readonly<Record<string, unknown>>, name: string): string {
	const value = row[name]
	if (typeof value !== 'string') {
		throw new QueryRefusedError(`${table}.${name} came back as ${typeof value}`)
	}
	return value
}

/** BIGINT and `count` come back as strings. */
function integer(table: string, row: Readonly<Record<string, unknown>>, name: string): number {
	const value = Number(row[name])
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new QueryRefusedError(`${table}.${name} is not a non-negative integer`)
	}
	return value
}

// A bound Date reaches Postgres as Date#toString() through this driver, so timestamps are bound as ISO strings.
export function fileTables(runtime: () => DataLayerRuntime): FileTables {
	const session = () => sessionOf(runtime().database)
	return Object.freeze({
		async insert(collection: string, file: NewFile): Promise<void> {
			const table = tableOf(collection)
			const values = new Map<string, string | number | null>([
				['id', file.id],
				['owner_id', file.ownerId],
				['object_key', file.objectKey],
				['size', file.size],
				['content_type', file.contentType],
				['sha256', file.sha256],
				['original_name', file.originalName],
				['created_by', file.createdBy],
				['created_at', file.createdAt.toISOString()],
			])
			await session().run(insertNode(table, values, acknowledgement(table, 'id', undefined)), guard('InsertQueryNode', table, undefined))
		},

		async find(collection: string, id: string): Promise<LiveFile | null> {
			const table = tableOf(collection)
			const scope = equals(table, 'id', id)
			const [row] = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, LIVE_COLUMNS), live(table), scope, 1),
				guard('SelectQueryNode', table, scope),
			)
			if (row === undefined) {
				return null
			}
			const originalName = row['original_name']
			return Object.freeze({
				id: text(table, row, 'id'),
				ownerId: text(table, row, 'owner_id'),
				objectKey: text(table, row, 'object_key'),
				size: integer(table, row, 'size'),
				contentType: text(table, row, 'content_type'),
				originalName: typeof originalName === 'string' ? originalName : null,
			})
		},

		async countLive(collection: string, ownerId: string): Promise<number> {
			const table = tableOf(collection)
			const scope = equals(table, 'owner_id', ownerId)
			const count = SelectionNode.create(
				AliasNode.create(AggregateFunctionNode.create('count', [SelectAllNode.create()]), IdentifierNode.create('count')),
			)
			const [row] = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, [count], isNull(table, 'deleted_at', false), scope),
				guard('SelectQueryNode', table, scope),
			)
			return row === undefined ? 0 : integer(table, row, 'count')
		},

		async markRemoved(collection: string, id: string, at: Date): Promise<boolean> {
			const table = tableOf(collection)
			const scope = equals(table, 'id', id)
			const node = updateNode(
				table,
				new Map([['deleted_at', at.toISOString()]]),
				undefined,
				scopedWhere(isNull(table, 'deleted_at', false), scope),
				acknowledgement(table, 'id', undefined),
			)
			const updated = await session().run(node, guard('UpdateQueryNode', table, scope))
			return updated.length > 0
		},

		async removable(collection: string, limit: number): Promise<readonly RemovableFile[]> {
			const table = tableOf(collection)
			const scope = everything()
			const rows = await session().run<Readonly<Record<string, unknown>>>(
				selectNode(table, selections(table, ['id', 'object_key']), removed(table), scope, limit),
				guard('SelectQueryNode', table, scope),
			)
			return rows.map((row) => Object.freeze({ id: text(table, row, 'id'), objectKey: text(table, row, 'object_key') }))
		},

		async purge(collection: string, id: string): Promise<void> {
			const table = tableOf(collection)
			const scope = equals(table, 'id', id)
			await session().run(deleteNode(table, scopedWhere(removed(table), scope), 'id'), guard('DeleteQueryNode', table, scope))
		},
	})
}
