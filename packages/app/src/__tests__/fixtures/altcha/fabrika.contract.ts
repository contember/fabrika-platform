// A registration behind an ALTCHA challenge the application issues itself, open to the environment's listed origins,
// over a copy of the intake fixture's tables, so the reader reads them from source; and the same form at its own path,
// with an action, a cost and a lifetime of its own.

import { defineApp } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { tables } from './src/db/tables'
import { vocabulary } from './src/vocabulary'

export const Registration = z.strictObject({ name: z.string().min(1), email: z.email(), challengeToken: z.string() })
const Received = z.strictObject({ received: z.boolean() })

const app = defineApp(vocabulary, tables)

const signups = app.group({}, (r) => ({
	register: r.mutation({
		input: Registration,
		output: Received,
		access: { public: true },
		actions: ['applications.submit'],
		admission: { origins: 'listed', challenge: { provider: 'altcha', secret: 'ALTCHA_HMAC_KEY' }, rate: { perClient: 20, perEndpoint: 50 } },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('applications.submit').applications.insert({ name: input.name, email: input.email })
		return { received: true }
	}),
	enroll: r.mutation({
		input: Registration,
		output: Received,
		access: { public: true },
		actions: ['applications.submit'],
		http: { path: '/enroll' },
		admission: { challenge: { provider: 'altcha', secret: 'ALTCHA_HMAC_KEY', action: 'enroll', cost: 2000, maxAgeMs: 120_000 } },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('applications.submit').applications.insert({ name: input.name, email: input.email })
		return { received: true }
	}),
}))

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { signups }),
	health: c.health('/healthz'),
}))
