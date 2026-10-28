// A write that kicks the job, a write that throws after it wrote, a write that puts a file, a read, a public procedure a
// test holds, and the job `tally` that counts the notes (due at 03:00 UTC, so only a kick or a test's alarm runs it
// while a test runs).

import { z } from 'zod/v4'
import { app } from '../app-kit'
import { cfpgDeps } from '../world'

const NewNote = z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) })
const InWorkspace = z.strictObject({ workspaceId: z.string().min(1) })
const Created = z.strictObject({ id: z.uuid() })
const Titles = z.strictObject({ titles: z.array(z.string()) })
const Pong = z.strictObject({ pong: z.literal(true) })

export const notes = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' }, kicks: ['tally'] })
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			ctx.kick('tally')
			return { id }
		}),
	createThenFail: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.notes.insert({ title: input.title })
			throw new Error('the handler fails after its write')
		}),
	attach: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			await ctx.files.put('attachments', new TextEncoder().encode(input.title), { type: 'text/plain' })
			return { id }
		}),
	titles: r.query({ input: InWorkspace, output: Titles, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ ctx }) => ({ titles: (await ctx.db.target.notes.list({ orderBy: [['title', 'asc']] })).items.map((note) => note.title) })),
	ping: r.query({ output: Pong, access: { public: true }, actions: ['notes.ping'] }).handle(async () => {
		await cfpgDeps.get().hold?.()
		return { pong: true }
	}),
}))

export const tally = app.cron('0 3 * * *', { actions: ['notes.read'] })
	.handle(async ({ ctx }) => {
		const world = cfpgDeps.get()
		await world.hold?.()
		const page = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list()
		world.runs.push({ job: 'tally', notes: page.items.length })
	})
