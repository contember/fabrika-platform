import { honeypot } from '@fabrika/app'
import { app } from './app-kit'
import { Application, Notice, Received, Signup } from './schemas'

/** No bucket a test fills by accident: a test sends up to 50 calls a minute from one client. */
const UNBOUNDED = { rate: { perClient: null, perEndpoint: null } } as const

export const visitors = app.group({}, (r) => ({
	signup: r.mutation({
		input: Signup,
		output: Received,
		access: { public: true },
		actions: ['signups.register'],
		admission: UNBOUNDED,
		kicks: ['welcome'],
	}).handle(async ({ input, ctx }) => {
		if (honeypot(input.website)) return { received: true }
		await ctx.db.app('signups.register').signups.insert({ email: input.email })
		ctx.kick('welcome')
		return { received: true }
	}),
	apply: r.mutation({
		input: Application,
		output: Received,
		access: { public: true },
		actions: ['signups.register'],
		admission: { challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }, rate: { perClient: 2 } },
		kicks: ['welcome'],
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('signups.register').applications.insert({ email: input.email })
		ctx.kick('welcome')
		return { received: true }
	}),
	notify: r.mutation({ input: Notice, output: Received, access: { public: true }, actions: ['signups.register'], admission: UNBOUNDED })
		.handle(async ({ input, ctx }) => {
			await ctx.db.app('signups.register').notices.insert({ email: input.email })
			return { received: true }
		}),
}))
