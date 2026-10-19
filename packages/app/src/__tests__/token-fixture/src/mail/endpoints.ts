// Signed tokens: a booking procedure answers its own management link, and a one-click unsubscribe reads the recipient
// from a token in the URL beside the mailbox provider's urlencoded body.

import { redirect, signedToken } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Empty = z.strictObject({})
export const Booked = z.strictObject({ id: z.uuid(), version: z.int(), manage: z.string() })
const Moved = z.strictObject({ version: z.int() })
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
	click: r.mutation({
		input: z.strictObject({ t: signedToken('click') }),
		output: redirect(),
		access: { public: true },
		actions: ['stats.click'],
		http: { method: 'GET' },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('stats.click').clicks.insert({ campaign: input.t.campaign })
		return { to: input.t.target }
	}),
	elsewhere: r.mutation({
		input: z.strictObject({ t: signedToken('click') }),
		output: redirect(),
		access: { public: true },
		actions: ['stats.click'],
		http: { method: 'GET' },
	}).handle(() => ({ to: 'https://elsewhere.example/' })),
}))

export const bookings = app.group({}, (r) => ({
	book: r.mutation({
		input: z.strictObject({ name: z.string().min(1).max(200), slot: z.string().min(1).max(50) }),
		output: Booked,
		access: { public: true },
		actions: ['bookings.book'],
		signs: ['booking'],
	}).handle(async ({ input, ctx }) => {
		const { id, version } = await ctx.db.app('bookings.book').bookings.insert({ name: input.name, slot: input.slot })
		return { id, version, manage: ctx.tokens.sign('booking', { booking: id }, { days: 30 }) }
	}),
	move: r.mutation({
		input: z.strictObject({ t: signedToken('booking'), slot: z.string().min(1).max(50), version: z.int() }),
		output: Moved,
		access: { public: true },
		actions: ['bookings.manage'],
	}).handle(({ input, ctx }) =>
		ctx.db.app('bookings.manage').bookings.update(input.t.booking, { slot: input.slot }, { expectVersion: input.version })
	),
	cancel: r.mutation({
		input: z.strictObject({ t: signedToken('booking'), version: z.int() }),
		output: Empty,
		access: { public: true },
		actions: ['bookings.manage'],
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app('bookings.manage').bookings.remove(input.t.booking, { expectVersion: input.version })
		return {}
	}),
	moveAnother: r.mutation({
		input: z.strictObject({ t: signedToken('booking'), other: z.uuid(), version: z.int() }),
		output: Moved,
		access: { public: true },
		actions: ['bookings.manage'],
	}).handle(({ input, ctx }) => ctx.db.app('bookings.manage').bookings.update(input.other, { slot: 'stolen' }, { expectVersion: input.version })),
}))

export const staff = app.group({ callers: ['human'] }, (r) => ({
	unsubscribes: r.query({ output: Unsubscribed, access: { action: 'mail.read', app: true } }).handle(async ({ ctx }) => ({
		items: (await ctx.db.app.unsubscribes.list()).items.map((row) => ({ email: row.email, campaign: row.campaign })),
	})),
	booking: r.query({
		input: z.strictObject({ id: z.uuid() }),
		output: z.strictObject({ slot: z.string() }),
		access: { action: 'mail.read', app: true },
	})
		.handle(async ({ input, ctx }) => ({ slot: (await ctx.db.app.bookings.get(input.id)).slot })),
	clicks: r.query({ output: z.strictObject({ count: z.int() }), access: { action: 'mail.read', app: true } }).handle(async ({ ctx }) => ({
		count: await ctx.db.app.clicks.count(),
	})),
}))

/** A newsletter of one message, whose one-click unsubscribe link carries a signed token. */
export const newsletter = app.cron('0 6 * * 1', {
	actions: ['mail.read'],
	mailer: 'installation',
	signs: ['unsubscribe'],
	egress: ['https://lists.example.com'],
}).handle(
	async ({ ctx }) => {
		const t = ctx.tokens.sign('unsubscribe', { email: 'reader@example.com', campaign: 'weekly' }, { days: 400 })
		await ctx.mail.send({
			to: 'reader@example.com',
			subject: 'This week',
			text: 'This week in the catalog.',
			idempotencyKey: `weekly-${ctx.runId}`,
			unsubscribe: { url: ctx.url('api.mail.unsubscribe', { query: { t } }) },
		})
	},
)
