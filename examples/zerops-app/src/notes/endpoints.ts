// The notes: each handler reaches its rows through `ctx.db`, bound to the capability its access form minted, in the
// invocation's one transaction. The file endpoints of `attachments` are the framework's and take no handler.

import { ConflictError, fromRow } from '@fabrika/app'
import { app } from '../app-kit'
import { ById, Done, NewNote, Note, NoteList, Saved, Versioned } from '../schemas'

export const notes = app.group({ callers: ['human', 'machine'] }, (r) => ({
	list: r.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.notes.list({ orderBy: [['title', 'asc']], limit: 200 })
			return { items: page.items.map((row) => fromRow(Note, row)) }
		}),
	get: r.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Note, await ctx.db.target.get())),
	create: r.mutation({ input: NewNote, output: Saved, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(({ input, ctx }) => ctx.db.target.notes.insert({ title: input.title, trashed: false })),
	trash: r.mutation({ input: Versioned, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ trashed: true }, { expectVersion: input.expectVersion })),
	restore: r.mutation({ input: Versioned, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			if (!(await ctx.db.target.getForUpdate()).trashed) throw new ConflictError('only a note in the trash is restored')
			return ctx.db.target.update({ trashed: false }, { expectVersion: input.expectVersion })
		}),
	remove: r.mutation({ input: Versioned, output: Done, access: { action: 'notes.delete', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.remove({ expectVersion: input.expectVersion })
			return { id: ctx.target.value }
		}),
}))

/** Deletes every note in the trash, nightly. A retried attempt lists again, so it deletes no note twice. */
export const purge = app.cron('0 3 * * *', { actions: ['notes.read', 'notes.delete'], scope: 'app', timeout: '5m', retries: 2 })
	.handle(async ({ ctx }) => {
		const trashed = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list({ where: [['trashed', '=', true]], limit: 200 })
		await ctx.transaction(async (tx) => {
			for (const note of trashed.items) {
				await tx.db.on(await ctx.ref('notes.delete', 'note', note.id)).remove({ expectVersion: note.version })
			}
		})
	})
