// Signed tokens: a booking procedure answers its own management link, and a one-click unsubscribe reads the recipient
// from a token in the URL beside the mailbox provider's urlencoded body.

import { signedToken } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Empty = z.strictObject({})
export const Booked = z.strictObject({ id: z.uuid(), manage: z.string() })
export const Unsubscribed = z.strictObject({ items: z.array(z.strictObject({ email: z.string(), campaign: z.string() })) })

export const mail = app.group({}, (r) => ({
	unsubscribe: r.mutation({
		input: z.strictObject({ 'List-Unsubscribe': z.literal('One-Click') }),
		output: Empty,
		access: { public: true },
		actions: ['mailing.unsubscribe'],
		http: { query: z.strictObject({ t: signedToken('unsubscribe') }), body: 'urlencoded' },
		admission: { rate: { perClient: null } },
	}).handle(async ({ query, ctx }) => {
		await ctx.db.app('mailing.unsubscribe').unsubscribes.insert(
			{ email: query.t.email, campaign: query.t.campaign },
			{ onConflict: { columns: ['email', 'campaign'], do: 'nothing' } },
		)
		return {}
	}),
}))

export const bookings = app.group({}, (r) => ({
	book: r.mutation({
		input: z.strictObject({ name: z.string().min(1).max(200), slot: z.string().min(1).max(50) }),
		output: Booked,
		access: { public: true },
		actions: ['bookings.book'],
		signs: ['booking'],
	}).handle(async ({ input, ctx }) => {
		const { id } = await ctx.db.app('bookings.book').bookings.insert({ name: input.name, slot: input.slot })
		return { id, manage: ctx.tokens.sign('booking', { booking: id }, { days: 30 }) }
	}),
}))

export const staff = app.group({ callers: ['human'] }, (r) => ({
	unsubscribes: r.query({ output: Unsubscribed, access: { action: 'mail.read', app: true } }).handle(async ({ ctx }) => ({
		items: (await ctx.db.app.unsubscribes.list()).items.map((row) => ({ email: row.email, campaign: row.campaign })),
	})),
}))
