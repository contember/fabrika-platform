// The handlers reach rows only through `ctx.db`, bound to the capability each access form minted.

import { NotFoundError } from '@fabrika/app'
import { app } from '../app-kit'
import {
	ById,
	ByNote,
	ByRoot,
	CancelInvitation,
	Comments,
	Count,
	Done,
	EditComment,
	Invite,
	Invited,
	LookUp,
	Members,
	Named,
	NamedList,
	NewNote,
	Note,
	Notes,
	Notice,
	Relate,
	RemoveMember,
	Rename,
	Share,
	Shared,
	Unshare,
} from '../schemas'

export const organizations = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Named, access: { action: 'organizations.read', on: 'organization', from: 'id' } })
		.handle(async ({ ctx }) => {
			const organization = await ctx.db.target.get()
			return { id: organization.id, name: organization.name }
		}),
	create: r.mutation({ output: Done, access: { action: 'organizations.create', creates: 'organization' } })
		.handle(({ ctx }) => ({ id: ctx.created.value })),
}))

export const workspaces = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ output: NamedList, access: { action: 'workspaces.read', over: 'organization' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.within.workspaces.list({ orderBy: [['id', 'asc']] })).items.map((workspace) => ({ id: workspace.id, name: workspace.name })),
		})),
	invite: r.mutation({ input: Invite, output: Invited, access: { action: 'workspaces.admin', on: 'workspace', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const invited = await ctx.members.assign(ctx.target, { email: input.email }, input.role)
			return { invitationId: 'invited' in invited ? invited.invited.invitationId : invited.assigned.principalId }
		}),
	remove: r.mutation({ input: RemoveMember, output: Done, access: { action: 'workspaces.admin', on: 'workspace', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.members.revoke(ctx.target, { principalId: input.principalId })
			return { id: ctx.target.value }
		}),
	members: r.query({ input: ById, output: Members, access: { action: 'workspaces.read', on: 'workspace', from: 'id' } })
		.handle(async ({ ctx }) => ({ items: (await ctx.members.list()).map(({ principalId, roles }) => ({ principalId, roles: [...roles] })) })),
	cancel: r.mutation({ input: CancelInvitation, output: Done, access: { action: 'workspaces.admin', on: 'workspace', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.members.revoke(ctx.target, { invitationId: input.invitationId })
			return { id: ctx.target.value }
		}),
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
	notice: r.query({ input: ById, output: Notice, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => {
			const [notice] = (await ctx.db.app.notices.list({ where: [['published', '=', true]], orderBy: [['id', 'desc']], limit: 1 })).items
			if (notice === undefined) throw new NotFoundError('no notice is published')
			return { id: notice.id, body: notice.body }
		}),
	editComment: r.mutation({ input: EditComment, output: Done, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.target.note_comments.update(input.commentId, { body: input.body })).id })),
	// A note of the workspace by its id, a row the generated cases seed in each scope (`rows`).
	lookUp: r.query({ input: LookUp, output: Note, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			const [note] = (await ctx.db.target.notes.list({ where: [['id', '=', input.noteId]] })).items
			if (note === undefined) throw new NotFoundError('the workspace holds no such note')
			return { id: note.id, title: note.title }
		}),
	// The thread from a root note, which answers 404 when the caller lists no workspace that holds it.
	thread: r.query({ input: ByRoot, output: Notes, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ input, ctx }) => {
			const [root] = (await ctx.db.within.notes.list({ where: [['id', '=', input.rootId]] })).items
			if (root === undefined) throw new NotFoundError('no listed workspace holds the root note')
			return { items: [{ id: root.id, title: root.title }] }
		}),
	relate: r.query({
		input: Relate,
		output: Done,
		access: {
			capabilities: {
				source: { action: 'notes.read', over: 'workspace' },
				target: { action: 'workspaces.read', in: 'organization', from: 'organizationId' },
			},
		},
	}).handle(async ({ input, ctx }) => {
		const [note] = (await ctx.db.over(ctx.capabilities.source).notes.list({ where: [['id', '=', input.noteId]] })).items
		if (note === undefined) throw new NotFoundError('no listed workspace holds the note')
		const [workspace] = (await ctx.db.in(ctx.capabilities.target).workspaces.list({ where: [['id', '=', input.intoId]] })).items
		if (workspace === undefined) throw new NotFoundError('the organization holds no such workspace')
		return { id: `${note.id}:${workspace.id}` }
	}),
	share: r.mutation({ input: Share, output: Shared, access: { action: 'notes.share', on: 'note', from: 'id' }, issues: 'shared' })
		.handle(async ({ input, ctx }) => {
			const link = await ctx.links.issue(ctx.target, { mount: 'shared', days: input.days })
			return { id: link.id, url: link.url }
		}),
	unshare: r.mutation({ input: Unshare, output: Done, access: { action: 'notes.share', on: 'note', from: 'id' }, issues: 'shared' })
		.handle(async ({ input, ctx }) => {
			await ctx.links.revoke(input.linkId)
			return { id: ctx.target.value }
		}),
}))

export const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'note',
	grants: ['notes.read'],
	issuedBy: 'notes.share',
	maxDays: 30,
	procedures: (l) => ({
		note: l.query({ output: Note, access: { action: 'notes.read' } })
			.handle(async ({ ctx }) => {
				const note = await ctx.db.target.get()
				return { id: note.id, title: note.title }
			}),
		notice: l.query({ output: Notice, access: { action: 'notes.read' } })
			.handle(async ({ ctx }) => {
				const [notice] = (await ctx.db.app.notices.list({ where: [['published', '=', true]], orderBy: [['id', 'desc']], limit: 1 })).items
				if (notice === undefined) throw new NotFoundError('no notice is published')
				return { id: notice.id, body: notice.body }
			}),
	}),
})

export const ops = app.group({ callers: ['machine'] }, (r) => ({
	count: r.query({ output: Count, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ ctx }) => ({ count: String(await ctx.db.within.notes.count()) })),
}))
