// The orders of the customers the caller reaches. Only the owner deletes one (`orders.delete`): accounting reads every
// order, and the proxy refuses its delete before the application sees it.

import { fromPage, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ById, Cursor, Done, Id, OrderStatus, Saved, Versioned } from '../schemas'

const Order = z.strictObject({
	id: Id,
	customerId: Id,
	number: z.string(),
	customerName: z.string(),
	title: z.string(),
	status: OrderStatus,
	dueOn: z.iso.date(),
	amountCzk: z.int(),
	version: z.int(),
})
const OrderPage = z.strictObject({ items: z.array(Order), next: z.nullable(z.string()) })
const ListOrders = z.strictObject({ status: OrderStatus.optional(), after: Cursor.optional() })
const NewOrder = z.strictObject({
	customerId: Id,
	number: z.string().min(1).max(40),
	title: z.string().min(1).max(200),
	dueOn: z.iso.date(),
	amountCzk: z.int().positive(),
})
const SetStatus = z.strictObject({ id: Id, expectVersion: z.int().positive(), status: OrderStatus })

export const orders = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: ListOrders, output: OrderPage, access: { action: 'orders.read', over: 'customer' } })
		.handle(async ({ input, ctx }) =>
			fromPage(
				Order,
				await ctx.db.within.orders.list({
					where: input.status === undefined ? [] : [['status', '=', input.status]],
					orderBy: [['due_on', 'asc']],
					after: input.after,
				}),
			)
		),
	get: r.query({ input: ById, output: Order, access: { action: 'orders.read', on: 'order', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Order, await ctx.db.target.get())),
	create: r.mutation({
		input: NewOrder,
		output: Saved,
		access: {
			capabilities: {
				customer: { action: 'customers.read', on: 'customer', from: 'customerId' },
				order: { action: 'orders.write', in: 'customer', from: 'customerId' },
			},
		},
	})
		.handle(async ({ input, ctx }) => {
			// The customer's name goes with the order, so accounting reads it without reading the customers.
			const customer = await ctx.db.on(ctx.capabilities.customer).get()
			return ctx.db.in(ctx.capabilities.order).orders.insert({
				number: input.number,
				customer_name: customer.name,
				title: input.title,
				status: 'nova',
				due_on: input.dueOn,
				amount_czk: input.amountCzk,
			})
		}),
	setStatus: r.mutation({ input: SetStatus, output: Saved, access: { action: 'orders.write', on: 'order', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ status: input.status }, { expectVersion: input.expectVersion })),
	remove: r.mutation({ input: Versioned, output: Done, access: { action: 'orders.delete', on: 'order', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.remove({ expectVersion: input.expectVersion })
			return { id: ctx.target.value }
		}),
}))
