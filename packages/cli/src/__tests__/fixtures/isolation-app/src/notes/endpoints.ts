// The handlers reach rows only through `ctx.db`, bound to the capability each access form minted.

import { NotFoundError } from '@fabrika/app'
import { app } from '../app-kit'
import {
	ById,
	ByNote,
	CancelInvitation,
	Comments,
	Count,
	Done,
	EditComment,
	Invite,
	Invited,
	Members,
	Named,
	NamedList,
	NewNote,
	Note,
	Notes,
	Notice,
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
