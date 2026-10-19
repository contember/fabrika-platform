// The framework's side of its own tables (`@fabrika/db/migrations`): webhook bindings and the delivery keys that
// make a replay a no-op. A delivery key is derived from authenticated content (`@fabrika/app` hashes the binding
// and the signed body), never from a header; the `delivery_id` column holds it. Only `@fabrika/app`'s webhook runtime reaches them, through `frameworkTablesOf`. Every
// statement is a guarded tree like a store's, keyed by equalities on the framework table itself.

import { BinaryOperationNode, type OperationNode, OperatorNode, ValueNode } from 'kysely'
import { type Session, sessionOf } from './database'
import { DatabaseError, QueryRefusedError } from './errors'
import type { GuardContext } from './guard'
import { WEBHOOK_BINDINGS_TABLE, WEBHOOK_DELIVERIES_TABLE } from './migrations'
import { acknowledgement, allOf, column, deleteNode, equals, insertNode, locateNode, scopedWhere } from './nodes'
import type { DataLayerRuntime } from './store'

/** One webhook binding: the scope value it reaches, the provider account it accepts, and its signing secret. */
export interface WebhookBinding {
	readonly id: string
	/** The webhook mount's name. */
	readonly webhook: string
	readonly scope: { readonly type: string; readonly value: string }
	/** The provider account: for GitHub, `installation:<id>` or `repository:<id>`, which a delivery must name. */
	readonly account: string
	readonly secret: string
}

export interface NewWebhookBinding extends WebhookBinding {
	readonly createdBy: string
	readonly createdAt: number
}

export interface WebhookTables {
	/** Records a binding, in `using` when given: the transaction of the procedure that binds. */
	createBinding(binding: NewWebhookBinding, using?: Session): Promise<void>
	/** The binding `id` of `webhook`, or `null`. */
	binding(webhook: string, id: string): Promise<WebhookBinding | null>
	/** Removes the binding when it belongs to `webhook` and `scope`, in `using` when given; `false` when there was none. */
	removeBinding(webhook: string, id: string, scope: { readonly type: string; readonly value: string }, using?: Session): Promise<boolean>
	/**
	 * Records a delivery key; `false` when the binding already received it within the retention window. Keys of the
	 * binding older than `retainedSince` are dropped first, so the table stays bounded.
	 */
	recordDelivery(bindingId: string, deliveryKey: string, receivedAt: number, retainedSince: number): Promise<boolean>
	/** Forgets a delivery whose handler failed, so the provider's redelivery runs it again. */
	forgetDelivery(bindingId: string, deliveryKey: string): Promise<void>
}

const BINDING_COLUMNS = ['id', 'webhook', 'scope_type', 'scope_value', 'account', 'secret']
const UNIQUE_VIOLATION = '23505'

function guard(root: GuardContext['root'], table: string, scope: OperationNode | undefined): GuardContext {
	return { root, table, joins: {}, scope }
}

function text(row: Readonly<Record<string, unknown>>, column: string): string {
	const value = row[column]
	if (typeof value !== 'string') {
		throw new QueryRefusedError('unexpected_row', `${WEBHOOK_BINDINGS_TABLE}.${column} came back as ${typeof value}`)
	}
	return value
}

function isUniqueViolation(error: unknown): boolean {
	return error instanceof DatabaseError && error.sqlState === UNIQUE_VIOLATION
}

export function webhookTables(runtime: () => DataLayerRuntime): WebhookTables {
	const session = () => sessionOf(runtime())
	return Object.freeze({
		async createBinding(binding: NewWebhookBinding, using?: Session): Promise<void> {
			const values = new Map<string, string | number>([
				['id', binding.id],
				['webhook', binding.webhook],
				['scope_type', binding.scope.type],
				['scope_value', binding.scope.value],
				['account', binding.account],
				['secret', binding.secret],
				['created_by', binding.createdBy],
				['created_at', binding.createdAt],
			])
			const node = insertNode(WEBHOOK_BINDINGS_TABLE, values, acknowledgement(WEBHOOK_BINDINGS_TABLE, 'id', undefined))
			await (using ?? session()).run(node, guard('InsertQueryNode', WEBHOOK_BINDINGS_TABLE, undefined))
		},

		async binding(webhook: string, id: string): Promise<WebhookBinding | null> {
			const scope = allOf([equals(WEBHOOK_BINDINGS_TABLE, 'id', id), equals(WEBHOOK_BINDINGS_TABLE, 'webhook', webhook)])
			const [row] = await session().run<Readonly<Record<string, unknown>>>(
				locateNode(WEBHOOK_BINDINGS_TABLE, BINDING_COLUMNS, scope),
				guard('SelectQueryNode', WEBHOOK_BINDINGS_TABLE, scope),
			)
			if (row === undefined) {
				return null
			}
			return Object.freeze({
				id: text(row, 'id'),
				webhook: text(row, 'webhook'),
				scope: Object.freeze({ type: text(row, 'scope_type'), value: text(row, 'scope_value') }),
				account: text(row, 'account'),
				secret: text(row, 'secret'),
			})
		},

		async removeBinding(webhook: string, id: string, scope: { readonly type: string; readonly value: string }, using?: Session): Promise<boolean> {
			const predicate = allOf([
				equals(WEBHOOK_BINDINGS_TABLE, 'id', id),
				equals(WEBHOOK_BINDINGS_TABLE, 'webhook', webhook),
				equals(WEBHOOK_BINDINGS_TABLE, 'scope_type', scope.type),
				equals(WEBHOOK_BINDINGS_TABLE, 'scope_value', scope.value),
			])
			const removed = await (using ?? session()).run(
				deleteNode(WEBHOOK_BINDINGS_TABLE, scopedWhere(undefined, predicate), 'id'),
				guard('DeleteQueryNode', WEBHOOK_BINDINGS_TABLE, predicate),
			)
			return removed.length > 0
		},

		async recordDelivery(bindingId: string, deliveryKey: string, receivedAt: number, retainedSince: number): Promise<boolean> {
			const binding = equals(WEBHOOK_DELIVERIES_TABLE, 'binding_id', bindingId)
			const expired = BinaryOperationNode.create(
				column(WEBHOOK_DELIVERIES_TABLE, 'received_at'),
				OperatorNode.create('<'),
				ValueNode.create(retainedSince),
			)
			await session().run(
				deleteNode(WEBHOOK_DELIVERIES_TABLE, scopedWhere(expired, binding), 'delivery_id'),
				guard('DeleteQueryNode', WEBHOOK_DELIVERIES_TABLE, binding),
			)
			const values = new Map<string, string | number>([['binding_id', bindingId], ['delivery_id', deliveryKey], ['received_at', receivedAt]])
			const node = insertNode(WEBHOOK_DELIVERIES_TABLE, values, acknowledgement(WEBHOOK_DELIVERIES_TABLE, 'delivery_id', undefined))
			try {
				await session().run(node, guard('InsertQueryNode', WEBHOOK_DELIVERIES_TABLE, undefined))
				return true
			} catch (error) {
				// The primary key decides between two concurrent copies of one delivery: exactly one insert wins.
				if (isUniqueViolation(error)) {
					return false
				}
				throw error
			}
		},

		async forgetDelivery(bindingId: string, deliveryKey: string): Promise<void> {
			const predicate = allOf([equals(WEBHOOK_DELIVERIES_TABLE, 'binding_id', bindingId), equals(WEBHOOK_DELIVERIES_TABLE, 'delivery_id', deliveryKey)])
			await session().run(
				deleteNode(WEBHOOK_DELIVERIES_TABLE, scopedWhere(undefined, predicate), 'delivery_id'),
				guard('DeleteQueryNode', WEBHOOK_DELIVERIES_TABLE, predicate),
			)
		},
	})
}
