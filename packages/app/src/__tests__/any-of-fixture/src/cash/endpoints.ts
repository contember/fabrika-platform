// One screen read by several roles: each `anyOf` endpoint admits a caller holding any of its actions as a global grant,
// and `ctx.db.app` reaches what the held ones reach together. `open` is a single-action endpoint beside them.

import { z } from 'zod/v4'
import { app } from '../app-kit'

const Desk = z.strictObject({ id: z.string(), label: z.string(), status: z.string() })
const Desks = z.strictObject({ items: z.array(Desk) })
const Detail = z.strictObject({ columns: z.array(z.string()), held: z.array(z.string()), canClose: z.boolean(), audits: z.boolean() })
const NewDesk = z.strictObject({ label: z.string(), status: z.enum(['open', 'closed', 'suspended']), auditNote: z.string() })
const NewEntry = z.strictObject({ deskId: z.string(), amount: z.int() })
const Saved = z.strictObject({ id: z.string() })
const Count = z.strictObject({ count: z.int() })

const desks = (page: { readonly items: readonly { readonly id: string; readonly label: string; readonly status: string }[] }) => ({
	items: page.items.map((row) => ({ id: row.id, label: row.label, status: row.status })),
})

export const cash = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ output: Desks, access: { anyOf: ['cash.read', 'cash.audit', 'cash.manage'], app: true } })
		.handle(async ({ ctx }) => desks(await ctx.db.app.desks.list({ orderBy: [['label', 'asc']] }))),
	detail: r.query({ input: z.strictObject({ id: z.string() }), output: Detail, access: { anyOf: ['cash.read', 'cash.audit'], app: true } })
		.handle(async ({ input, ctx }) => ({
			columns: Object.keys(await ctx.db.app.desks.get(input.id)).sort(),
			held: [...ctx.app.actions],
			canClose: ctx.holds('cash.manage'),
			audits: ctx.holds('cash.audit'),
		})),
	open: r.query({ output: Desks, access: { action: 'cash.read', app: true } })
		.handle(async ({ ctx }) => desks(await ctx.db.app.desks.list({ orderBy: [['label', 'asc']] }))),
	record: r.mutation({ input: NewEntry, output: Saved, access: { anyOf: ['cash.manage', 'cash.audit'], app: true } })
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.app.entries.insert({ desk_id: input.deskId, amount: input.amount })).id })),
	add: r.mutation({ input: NewDesk, output: Saved, access: { action: 'cash.manage', app: true } })
		.handle(async ({ input, ctx }) => ({
			id: (await ctx.db.app.desks.insert({ label: input.label, status: input.status, audit_note: input.auditNote })).id,
		})),
	entries: r.query({ output: Count, access: { action: 'cash.manage', app: true } })
		.handle(async ({ ctx }) => ({ count: (await ctx.db.app.entries.list()).items.length })),
}))
