// A write and a read in a workspace, a write that throws after it wrote, a write and a put that throw after them, two
// jobs that count the notes (one due at 03:00 UTC, one at minute 30 of every hour), and a job whose transaction puts a
// file and throws (minute 15).

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
	attachThenFail: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			// The write opens the transaction first, so the put's pending row is written inside it.
			await ctx.db.target.notes.insert({ title: input.title })
			await ctx.files.put('attachments', new TextEncoder().encode(input.title), { type: 'text/plain' })
			throw new Error('the handler fails after its put')
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

export const putThenFail = app.cron('15 * * * *', { actions: ['notes.read'] })
	.handle(async ({ ctx }) => {
		await ctx.transaction(async (tx) => {
			await tx.files.put('attachments', new TextEncoder().encode('gone'), { type: 'text/plain' })
			throw new Error('the transaction fails after its put')
		})
	})
