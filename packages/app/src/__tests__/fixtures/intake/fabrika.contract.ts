// A public intake: a registration with a honeypot and a Turnstile challenge, the same registration at a 0.5 form's URL
// and widget action, and a plain contact message, each a public procedure that writes an application table. Each
// declares its own rate, small enough for a test to empty its buckets.

import { honeypot } from '@fabrika/app'
import { defineApp } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { tables } from './src/db/tables'
import { vocabulary } from './src/vocabulary'

export const Application = z.strictObject({
	name: z.string().min(1),
	email: z.email(),
	website: z.optional(z.string()),
	challengeToken: z.string(),
})
export const Contact = z.strictObject({ email: z.email(), body: z.string().min(1) })
const Received = z.strictObject({ received: z.boolean() })

const app = defineApp(vocabulary, tables)

const intake = app.group({}, (r) => ({
	apply: r.mutation({
		input: Application,
		output: Received,
		access: { public: true },
		actions: ['applications.submit'],
		admission: { challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }, rate: { perClient: 3, perEndpoint: 5 } },
	}).handle(async ({ input, ctx }) => {
		if (honeypot(input.website)) return { received: true }
		await ctx.db.app('applications.submit').applications.insert({ name: input.name, email: input.email })
		return { received: true }
	}),
	register: r.mutation({
		input: Application,
		output: Received,
		access: { public: true },
		actions: ['applications.submit'],
		http: { path: '/register' },
		admission: {
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', action: 'register' },
			rate: { perClient: 3, perEndpoint: 5 },
		},
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('applications.submit').applications.insert({ name: input.name, email: input.email })
		return { received: true }
	}),
	contact: r.mutation({
		input: Contact,
		output: Received,
		access: { public: true },
		actions: ['messages.send'],
		admission: { rate: { perClient: 2, perEndpoint: 4 } },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('messages.send').messages.insert({ email: input.email, body: input.body })
		return { received: true }
	}),
}))

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { intake }),
	health: c.health('/healthz'),
}))
