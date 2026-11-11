// The customers of the firm, and the salespeople assigned to them. An assignment row is what gives a salesperson their
// customer (`handling` in the vocabulary): the owner writes it, and the salesperson reaches the customer and its orders
// exactly while it exists.

import { fromPage, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ById, Cursor, Done, Id, Saved } from '../schemas'

const Customer = z.strictObject({
	id: Id,
	name: z.string(),
	ico: z.string(),
	city: z.string(),
	email: z.string(),
	version: z.int(),
})
const CustomerPage = z.strictObject({ items: z.array(Customer), next: z.nullable(z.string()) })
const ListCustomers = z.strictObject({ after: Cursor.optional() })
const NewCustomer = z.strictObject({
	firmId: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	ico: z.string().regex(/^[0-9]{8}$/, 'IČO má osm číslic'),
	city: z.string().min(1).max(100),
	email: z.email(),
})
const Rep = z.strictObject({
	id: Id,
	customerId: Id,
	principalId: z.string(),
	label: z.string(),
	customerName: z.string(),
	customerCity: z.string(),
})
const RepList = z.strictObject({ items: z.array(Rep) })
const Assign = z.strictObject({
	id: Id,
	salesperson: z.string().min(1).max(200),
	label: z.string().min(1).max(200),
})
const Unassign = z.strictObject({ id: Id, assignment: Id })

export const customers = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: ListCustomers, output: CustomerPage, access: { action: 'customers.read', over: 'firm' } })
		.handle(async ({ input, ctx }) => fromPage(Customer, await ctx.db.within.customers.list({ orderBy: [['name', 'asc']], after: input.after }))),
	get: r.query({ input: ById, output: Customer, access: { action: 'customers.read', on: 'customer', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Customer, await ctx.db.target.get())),
	create: r.mutation({ input: NewCustomer, output: Saved, access: { action: 'customers.write', in: 'firm', from: 'firmId' } })
		.handle(({ input, ctx }) => ctx.db.target.customers.insert({ name: input.name, ico: input.ico, city: input.city, email: input.email })),
	// The assignments the caller reads: every one for the owner, their own customers for a salesperson.
	reps: r.query({ output: RepList, access: { action: 'customers.read', over: 'customer' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.customer_reps.list({ orderBy: [['label', 'asc']], limit: 500 })
			return { items: page.items.map((row) => fromRow(Rep, row)) }
		}),
	assign: r.mutation({
		input: Assign,
		output: Done,
		access: {
			capabilities: {
				customer: { action: 'customers.read', on: 'customer', from: 'id' },
				assignment: { action: 'customers.assign', on: 'customer', from: 'id' },
			},
		},
	})
		.handle(async ({ input, ctx }) => {
			const customer = await ctx.db.on(ctx.capabilities.customer).get()
			return ctx.db.on(ctx.capabilities.assignment).customer_reps.insert({
				principal_id: input.salesperson,
				label: input.label,
				customer_name: customer.name,
				customer_city: customer.city,
			})
		}),
	unassign: r.mutation({ input: Unassign, output: Done, access: { action: 'customers.assign', on: 'customer', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.customer_reps.remove(input.assignment)
			return { id: input.assignment }
		}),
}))
