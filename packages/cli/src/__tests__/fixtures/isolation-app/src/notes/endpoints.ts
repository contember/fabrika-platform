// The handlers reach rows only through `ctx.db`, bound to the capability each access form minted.

import { app } from '../app-kit'
import { ById, ByNote, Comments, Count, Done, Named, NamedList, NewNote, Note, Notes, Rename } from '../schemas'

export const organizations = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Named, access: { action: 'organizations.read', on: 'organization', from: 'id' } })
		.handle(async ({ ctx }) => {
			const organization = await ctx.db.target.get()
			return { id: organization.id, name: organization.name }
		}),
}))

export const workspaces = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ output: NamedList, access: { action: 'workspaces.read', over: 'organization' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.within.workspaces.list({ orderBy: [['id', 'asc']] })).items.map((workspace) => ({ id: workspace.id, name: workspace.name })),
		})),
}))

export const notes = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => {
			const note = await ctx.db.target.get()
			return { id: note.id, title: note.title }
		}),
	list: r.query({ output: Notes, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.within.notes.list({ orderBy: [['id', 'asc']] })).items.map((note) => ({ id: note.id, title: note.title })),
		})),
	create: r.mutation({ input: NewNote, output: Done, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.notes.insert({ title: input.title, pinned: false })).id })),
	rename: r.mutation({ input: Rename, output: Done, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.update({ title: input.title }, { expectVersion: input.expectVersion })).id })),
	comments: r.query({ input: ByNote, output: Comments, access: { action: 'notes.read', on: 'note', from: 'noteId' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.target.note_comments.list({ orderBy: [['id', 'asc']] })).items.map((comment) => ({ id: comment.id, body: comment.body })),
		})),
}))

export const ops = app.group({ callers: ['machine'] }, (r) => ({
	count: r.query({ output: Count, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ ctx }) => ({ count: String(await ctx.db.within.notes.count()) })),
}))
