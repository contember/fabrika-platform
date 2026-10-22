// A write and a read in a workspace, a write that throws after it wrote, and two jobs that count the notes: one due
// at 03:00 UTC, one at minute 30 of every hour.

import { z } from 'zod/v4'
import { app } from '../app-kit'
import { notesDeps } from '../world'

const NewNote = z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) })
const InWorkspace = z.strictObject({ workspaceId: z.string().min(1) })
const Created = z.strictObject({ id: z.uuid() })
const Titles = z.strictObject({ titles: z.array(z.string()) })

export const notes = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			return { id }
		}),
	createThenFail: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.notes.insert({ title: input.title })
			throw new Error('the handler fails after its write')
		}),
	titles: r.query({ input: InWorkspace, output: Titles, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ ctx }) => ({ titles: (await ctx.db.target.notes.list({ orderBy: [['title', 'asc']] })).items.map((note) => note.title) })),
}))

export const nightly = app.cron('0 3 * * *', { actions: ['notes.read'] })
	.handle(async ({ ctx }) => {
		const page = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list()
		notesDeps.get().runs.push({ job: 'nightly', notes: page.items.length })
	})

export const halfPast = app.cron('30 * * * *', { actions: ['notes.read'] })
	.handle(async ({ ctx }) => {
		const page = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list()
		notesDeps.get().runs.push({ job: 'halfPast', notes: page.items.length })
	})
