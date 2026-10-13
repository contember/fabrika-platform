// Application-wide data on the paved road: the positions an administrator edits, the counts and the audited export of
// every candidate. Each endpoint's action must be held as a global grant; the proxy refuses a scoped holder.

import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Position = z.strictObject({ id: z.uuid(), title: z.string(), active: z.boolean(), version: z.int() })
const Positions = z.strictObject({ items: z.array(Position) })
const Title = z.strictObject({ title: z.string().min(1).max(200) })
const Edit = z.strictObject({ id: z.uuid(), title: z.string().min(1).max(200), active: z.boolean(), expectVersion: z.int() })
const ById = z.strictObject({ id: z.uuid(), expectVersion: z.int() })
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
const Done = z.strictObject({ done: z.boolean() })
const Counts = z.strictObject({ items: z.array(z.strictObject({ status: z.string(), count: z.string() })) })
const Columns = z.strictObject({ columns: z.array(z.string()) })
const Row = z.strictObject({ id: z.string(), name: z.string(), status: z.string() })
const Log = z.strictObject({ items: z.array(z.strictObject({ rows: z.int(), createdBy: z.string() })) })

export const admin = app.group({ callers: ['human'] }, (r) => ({
	positions: r.query({ output: Positions, access: { action: 'positions.read', app: true } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.app.positions.list({ orderBy: [['title', 'asc']] })).items.map((row) => ({
				id: row.id,
				title: row.title,
				active: row.active,
				version: row.version,
			})),
		})),
	add: r.mutation({ input: Title, output: Saved, access: { action: 'positions.manage', app: true } })
		.handle(async ({ input, ctx }) => ctx.db.app.positions.insert({ title: input.title })),
	edit: r.mutation({ input: Edit, output: Saved, access: { action: 'positions.manage', app: true } })
		.handle(async ({ input, ctx }) => {
			const position = await ctx.db.app.positions.getForUpdate(input.id)
			return ctx.db.app.positions.update(position.id, { title: input.title, active: input.active }, { expectVersion: input.expectVersion })
		}),
	drop: r.mutation({ input: ById, output: Done, access: { action: 'positions.manage', app: true } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.app.positions.remove(input.id, { expectVersion: input.expectVersion })
			return { done: true }
		}),
	columns: r.query({ input: z.strictObject({ id: z.uuid() }), output: Columns, access: { action: 'positions.manage', app: true } })
		.handle(async ({ input, ctx }) => ({ columns: Object.keys(await ctx.db.app.positions.get(input.id)).sort() })),
	counts: r.query({ output: Counts, access: { action: 'candidates.read', app: true } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.app.candidates.aggregate({ groupBy: ['status'], count: true })).map((row) => ({ status: row.status, count: row.count })),
		})),
	audit: r.query({ output: Log, access: { action: 'audit.read', app: true } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.app.exports.list({ orderBy: [['created_at', 'asc']] })).items.map((row) => ({ rows: row.rows, createdBy: row.created_by })),
		})),
	export: r.mutation({
		output: attachment({ format: 'csv', filename: 'candidates.csv', row: Row, maxBytes: 1048576, maxRows: 500 }),
		access: { action: 'candidates.read', app: true },
	})
		.handle(async ({ ctx }) => {
			const page = await ctx.db.app.candidates.list({ orderBy: [['name', 'asc']], limit: 500 })
			await ctx.db.app.exports.insert({ rows: page.items.length })
			return page.items.map((row) => ({ id: row.id, name: row.name, status: row.status }))
		}),
}))
