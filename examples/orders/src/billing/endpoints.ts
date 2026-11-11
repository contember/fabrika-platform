// The invoicing records: accounting prepares one from an order and marks it billed with the invoice number.

import { ConflictError, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { BillingStatus, Done, Id } from '../schemas'
import { withVat } from './logic'

const Billing = z.strictObject({
	id: Id,
	orderId: Id,
	amountCzk: z.int(),
	vatRate: z.int(),
	status: BillingStatus,
	invoiceNumber: z.nullable(z.string()),
	version: z.int(),
})
const BillingRow = Billing.extend({ totalCzk: z.int() })
const BillingList = z.strictObject({ items: z.array(BillingRow) })
const Prepare = z.strictObject({ orderId: Id, vatRate: z.union([z.literal(12), z.literal(21)]) })
const MarkInvoiced = z.strictObject({
	orderId: Id,
	id: Id,
	expectVersion: z.int().positive(),
	invoiceNumber: z.string().min(1).max(40),
})

export const billing = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ output: BillingList, access: { action: 'billing.read', over: 'order' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.billing.list({ limit: 500 })
			return {
				items: page.items.map((row) => {
					const item = fromRow(Billing, row)
					return { ...item, totalCzk: withVat(item.amountCzk, item.vatRate) }
				}),
			}
		}),
	prepare: r.mutation({
		input: Prepare,
		output: Done,
		access: {
			capabilities: {
				order: { action: 'orders.read', on: 'order', from: 'orderId' },
				billing: { action: 'billing.write', on: 'order', from: 'orderId' },
			},
		},
	})
		.handle(async ({ input, ctx }) => {
			const order = await ctx.db.on(ctx.capabilities.order).get()
			const records = ctx.db.on(ctx.capabilities.billing).billing
			if ((await records.list({ limit: 1 })).items.length > 0) {
				throw new ConflictError('podklad k fakturaci této objednávky už existuje')
			}
			const saved = await records.insert({ amount_czk: order.amount_czk, vat_rate: input.vatRate, status: 'pripraveno' })
			return { id: saved.id }
		}),
	markInvoiced: r.mutation({ input: MarkInvoiced, output: Done, access: { action: 'billing.write', on: 'order', from: 'orderId' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.billing.update(input.id, { status: 'vyfakturovano', invoice_number: input.invoiceNumber }, {
				expectVersion: input.expectVersion,
			})
			return { id: input.id }
		}),
}))
