// The notes of a project: a write that may carry a file, a read of them back, the download of a note's file, and the
// job that stamps every note it has not reviewed yet.

import { NotFoundError } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { app } from '../app-kit'
import { Created, InProject, NewNote, NoteList, OneNote } from '../schemas'

export const notes = app.group({ callers: ['human', 'machine'] }, (r) => ({
	create: r.mutation({ input: NewNote, output: Created, access: { action: 'example.write', in: 'project', from: 'projectId' } })
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title, attachment: input.attachment ?? null })
			return { id }
		}),
	list: r.query({ input: InProject, output: NoteList, access: { action: 'example.read', in: 'project', from: 'projectId' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.target.notes.list({ orderBy: [['created_at', 'asc']] })
			return {
				items: page.items.map((note) => ({ id: note.id, title: note.title, reviewedAt: note.reviewed_at, attachment: note.attachment })),
			}
		}),
	attachment: r.query({ input: OneNote, output: file('attachments'), access: { action: 'example.read', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => {
			const note = await ctx.db.target.get()
			if (note.attachment === null) {
				throw new NotFoundError('the note has no attachment')
			}
			return note.attachment
		}),
}))

export const review = app.cron('* * * * *', { actions: ['example.read', 'example.write'] })
	.handle(async ({ ctx }) => {
		const all = ctx.db.over(ctx.within('example.read', 'project')).notes
		let after: string | undefined
		do {
			const page = await all.list({ limit: 100, after })
			for (const note of page.items.filter((listed) => listed.reviewed_at === null)) {
				const ref = await ctx.ref('example.write', 'note', note.id)
				await ctx.transaction(async (tx) => {
					const locked = await tx.db.on(ref).getForUpdate()
					if (locked.reviewed_at === null) {
						await tx.db.on(ref).update({ reviewed_at: new Date().toISOString() }, { expectVersion: locked.version })
					}
				})
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
