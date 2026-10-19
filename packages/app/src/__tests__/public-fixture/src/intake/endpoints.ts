// Public procedures beside the staff who read what they wrote: an anonymous intake, a capped one, two that overreach,
// and a public catalog read.

import { honeypot } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Register = z.strictObject({ name: z.string().min(1).max(200), website: z.string().max(200) })
const Empty = z.strictObject({})
const Products = z.strictObject({ items: z.array(z.strictObject({ name: z.string() })) })
export const Submitted = z.strictObject({
	items: z.array(z.strictObject({ name: z.string(), clientIp: z.nullable(z.string()), userAgent: z.nullable(z.string()) })),
})

export const intake = app.group({}, (r) => ({
	register: r.mutation({ input: Register, output: Empty, access: { public: true }, actions: ['intake.register'] })
		.handle(async ({ input, ctx }) => {
			if (honeypot(input.website)) return {}
			await ctx.db.app('intake.register').submissions.insert({
				name: input.name,
				client_ip: ctx.client.ip,
				user_agent: ctx.client.userAgent,
			})
			return {}
		}),
	limited: r.mutation({
		input: Register,
		output: Empty,
		access: { public: true },
		actions: ['intake.register'],
		admission: { rate: { perClient: 2, perEndpoint: null } },
		limits: { maxBytes: 1024, timeoutMs: 2000 },
	}).handle(() => ({})),
	overreach: r.mutation({ output: Empty, access: { public: true }, actions: ['intake.register'] }).handle(async ({ ctx }) => {
		// The types refuse an update; at run time the data layer refuses it as well.
		const update: unknown = Reflect.get(ctx.db.app('intake.register').submissions, 'update')
		if (typeof update === 'function') await Reflect.apply(update, undefined, [crypto.randomUUID(), { name: 'x' }])
		return {}
	}),
	undeclared: r.mutation({ output: Empty, access: { public: true }, actions: ['intake.register'] }).handle(({ ctx }) => {
		Reflect.apply(ctx.app, ctx, ['catalog.read'])
		return {}
	}),
}))

export const catalog = app.group({}, (r) => ({
	products: r.query({ output: Products, access: { public: true }, actions: ['catalog.read'] }).handle(async ({ ctx }) => ({
		items: (await ctx.db.app('catalog.read').products.list()).items.map((row) => ({ name: row.name })),
	})),
}))

export const staff = app.group({ callers: ['human'] }, (r) => ({
	submissions: r.query({ output: Submitted, access: { action: 'intake.read', app: true }, admission: { rate: { perCaller: 600 } } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.app.submissions.list()).items.map((row) => ({ name: row.name, clientIp: row.client_ip, userAgent: row.user_agent })),
		})),
	addProduct: r.mutation({
		input: z.strictObject({ name: z.string() }),
		output: Empty,
		access: { action: 'catalog.write', app: true },
		admission: { rate: { perCaller: 3 } },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.app.products.insert({ name: input.name })
			return {}
		}),
}))
