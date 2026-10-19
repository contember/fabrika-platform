// The public procedures of the intake: each writes one row and answers a constant, whatever the database holds, so
// neither its answer nor its work tells a visitor whether an address is known.

import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Register, Resend } from '../schemas'

const Received = z.strictObject({ received: z.boolean() })

export const visitors = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Received,
		access: { public: true },
		actions: ['candidates.register'],
		limits: { maxBytes: 2048 },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('candidates.register').registrations.insert({ email: input.email, name: input.name })
		return { received: true }
	}),
	resend: r.mutation({
		input: Resend,
		output: Received,
		access: { public: true },
		actions: ['candidates.register'],
		limits: { maxBytes: 1024 },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('candidates.register').resend_requests.insert({ email: input.email })
		return { received: true }
	}),
}))
