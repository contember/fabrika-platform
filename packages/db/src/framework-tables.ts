// The framework's side of its own tables (`@fabrika/db/migrations`): webhook bindings and the delivery keys that
// make a replay a no-op. A delivery key is derived from authenticated content (`@fabrika/app` hashes the binding
// and the signed body), never from a header; the `delivery_id` column holds it, claimed under a lease and completed
// in the handler's transaction. Only `@fabrika/app`'s webhook runtime reaches them, through `frameworkTablesOf`. Every
// statement is a guarded tree like a store's, keyed by equalities on the framework table itself.

import { BinaryOperationNode, type OperationNode, OperatorNode, ValueNode } from 'kysely'
import { runFixedStatement, type Session, sessionOf } from './database'
import { QueryRefusedError } from './errors'
import type { GuardContext } from './guard'
import { WEBHOOK_BINDINGS_TABLE, WEBHOOK_DELIVERIES_TABLE } from './migrations'
import { acknowledgement, allOf, column, deleteNode, equals, insertNode, locateNode, scopedWhere, updateNode } from './nodes'
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
	/**
	 * Replaces the secret of the binding when it belongs to `webhook` and `scope`, in `using` when given: a provider that
	 * issues its own signing secret shows it only after the binding's URL is registered. `false` when there was none.
	 */
	replaceSecret(
		webhook: string,
		id: string,
		scope: { readonly type: string; readonly value: string },
		secret: string,
		using?: Session,
	): Promise<boolean>
	/** Removes the binding when it belongs to `webhook` and `scope`, in `using` when given; `false` when there was none. */
	removeBinding(webhook: string, id: string, scope: { readonly type: string; readonly value: string }, using?: Session): Promise<boolean>
	/**
	 * Claims a delivery key for `leaseMs`: `null` when the binding completed it within the retention window, or another
	 * copy holds an unexpired claim. A claim whose lease expired is taken over. Keys of the binding older than
	 * `retainedSince` are dropped first, so the table stays bounded.
	 */
	claimDelivery(bindingId: string, deliveryKey: string, now: number, leaseMs: number, retainedSince: number): Promise<DeliveryClaim | null>
	/**
	 * Completes a claimed delivery in `using`, the transaction its handler wrote in, so the work and the completion
	 * commit together; `false` when another copy took the claim over meanwhile, and that transaction must not commit.
	 * Without `using` (a handler with no transaction) it completes on its own.
	 */
	completeDelivery(claim: DeliveryClaim, using?: Session): Promise<boolean>
	/** Gives a claim back after its handler failed, so the provider's redelivery runs it again at once. */
	releaseDelivery(claim: DeliveryClaim): Promise<void>
}

/** One copy's claim on a delivery: its lease end fences the completion against a copy that took the claim over. */
export interface DeliveryClaim {
	readonly bindingId: string
	readonly key: string
	readonly leaseUntil: number
}

const D = WEBHOOK_DELIVERIES_TABLE

/** A new key, or one whose claim expired without completion; a completed one (no lease) is never taken. */
const SQL_CLAIM = `insert into ${D} (binding_id, delivery_id, received_at, lease_until) values ($1, $2, $3::bigint, $4::bigint)
on conflict (binding_id, delivery_id) do update set received_at = excluded.received_at, lease_until = excluded.lease_until
where ${D}.lease_until is not null and ${D}.lease_until < excluded.received_at
returning delivery_id`

const SQL_COMPLETE = `update ${D} set lease_until = null
where binding_id = $1 and delivery_id = $2 and lease_until = $3::bigint
returning delivery_id`

const SQL_RELEASE = `delete from ${D} where binding_id = $1 and delivery_id = $2 and lease_until = $3::bigint returning delivery_id`

const BINDING_COLUMNS = ['id', 'webhook', 'scope_type', 'scope_value', 'account', 'secret']

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

/** The binding `id` of `webhook`, only when it reaches `scope`. */
function bindingOf(webhook: string, id: string, scope: { readonly type: string; readonly value: string }): OperationNode {
	return allOf([
		equals(WEBHOOK_BINDINGS_TABLE, 'id', id),
		equals(WEBHOOK_BINDINGS_TABLE, 'webhook', webhook),
		equals(WEBHOOK_BINDINGS_TABLE, 'scope_type', scope.type),
		equals(WEBHOOK_BINDINGS_TABLE, 'scope_value', scope.value),
	])
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

		async replaceSecret(
			webhook: string,
			id: string,
			scope: { readonly type: string; readonly value: string },
			secret: string,
			using?: Session,
		): Promise<boolean> {
			const predicate = bindingOf(webhook, id, scope)
			const replaced = await (using ?? session()).run(
				updateNode(
					WEBHOOK_BINDINGS_TABLE,
					new Map([['secret', secret]]),
					undefined,
					scopedWhere(undefined, predicate),
					acknowledgement(WEBHOOK_BINDINGS_TABLE, 'id', undefined),
				),
				guard('UpdateQueryNode', WEBHOOK_BINDINGS_TABLE, predicate),
			)
			return replaced.length > 0
		},

		async removeBinding(webhook: string, id: string, scope: { readonly type: string; readonly value: string }, using?: Session): Promise<boolean> {
			const predicate = bindingOf(webhook, id, scope)
			const removed = await (using ?? session()).run(
				deleteNode(WEBHOOK_BINDINGS_TABLE, scopedWhere(undefined, predicate), 'id'),
				guard('DeleteQueryNode', WEBHOOK_BINDINGS_TABLE, predicate),
			)
			return removed.length > 0
		},

		async claimDelivery(bindingId: string, deliveryKey: string, now: number, leaseMs: number, retainedSince: number): Promise<DeliveryClaim | null> {
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
			const leaseUntil = now + leaseMs
			// The primary key decides between concurrent copies of one delivery: exactly one inserts or takes over.
			const claimed = await runFixedStatement(session(), SQL_CLAIM, [bindingId, deliveryKey, now, leaseUntil])
			return claimed.length === 0 ? null : Object.freeze({ bindingId, key: deliveryKey, leaseUntil })
		},

		async completeDelivery(claim: DeliveryClaim, using?: Session): Promise<boolean> {
			const completed = await runFixedStatement(using ?? session(), SQL_COMPLETE, [claim.bindingId, claim.key, claim.leaseUntil])
			return completed.length > 0
		},

		async releaseDelivery(claim: DeliveryClaim): Promise<void> {
			await runFixedStatement(session(), SQL_RELEASE, [claim.bindingId, claim.key, claim.leaseUntil])
		},
	})
}
