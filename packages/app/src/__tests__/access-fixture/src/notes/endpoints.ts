// The cases of the endpoint access kit: a write that reads its own target, a patch whose only field is optional, a precondition (`restore` only a trashed
// note), a report in an organization through `ctx.sql`, ones that forget their scope (also only in the state a seed would
// skip, or only in an outer dimension's values), and a link holder's read.

import { ConflictError } from '@fabrika/app'
import { app } from '../app-kit'
import { ById, InOrganization, InWorkspace, Note, Notes, OrganizationId, Organizations, Retitle, Saved, Title, Titles, Versioned } from '../schemas'

export const notes = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => {
			const note = await ctx.db.target.get()
			return { id: note.id, title: note.title, trashed: note.trashed }
		}),
	list: r.query({ output: Notes, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.db.within.notes.list()).items.map((note) => ({ id: note.id, title: note.title, trashed: note.trashed })),
		})),
	trash: r.mutation({ input: Versioned, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => ctx.db.target.update({ trashed: true }, { expectVersion: input.expectVersion })),
	retitle: r.mutation({ input: Retitle, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => ctx.db.target.update({ title: input.title }, { expectVersion: input.expectVersion })),
	restore: r.mutation({ input: Versioned, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			if (!(await ctx.db.target.getForUpdate()).trashed) throw new ConflictError('only a trashed note is restored')
			return ctx.db.target.update({ trashed: false }, { expectVersion: input.expectVersion })
		}),
	titles: r.query({ input: InOrganization, output: Titles, access: { action: 'notes.read', in: 'organization', from: 'organizationId' }, sql: 'read' })
		.handle(async ({ ctx }) => ({
			titles: (await ctx.sql(Note)`select id, title, trashed from notes where organization_id = ${ctx.target.value} order by title`).map((note) =>
				note.title
			),
		})),
	scopedTitles: r.query({
		input: InOrganization,
		output: Titles,
		access: { action: 'notes.read', in: 'organization', from: 'organizationId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			titles: (await ctx.sql(Note)`select n.id, n.title, n.trashed from notes n where ${ctx.sql.scope(ctx.target, 'notes', 'n')} order by n.title`)
				.map((note) => note.title),
		})),
	workspaceTitles: r.query({
		input: InWorkspace,
		output: Titles,
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			titles: (await ctx.sql(Title)`select title from notes where ${ctx.sql.scope(ctx.target, 'notes')} order by title`).map((row) => row.title),
		})),
	filteredTitles: r.query({
		input: InOrganization,
		output: Titles,
		access: { action: 'notes.read', in: 'organization', from: 'organizationId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			titles: (await ctx.sql(Title)`select n.title from notes n
				where (n.trashed or n.title <> ${''}) and ${ctx.sql.scope(ctx.target, 'notes', 'n')} order by n.title`).map((row) => row.title),
		})),
	orTitles: r.query({
		input: InOrganization,
		output: Titles,
		access: { action: 'notes.read', in: 'organization', from: 'organizationId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			titles: (await ctx.sql(Title)`select n.title from notes n
				where n.title <> ${''} or ${ctx.sql.scope(ctx.target, 'notes', 'n')} order by n.title`).map((row) => row.title),
		})),
	everyTitle: r.query({
		input: InOrganization,
		output: Titles,
		access: { action: 'notes.read', in: 'organization', from: 'organizationId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({ titles: (await ctx.sql(Note)`select id, title, trashed from notes order by title`).map((note) => note.title) })),
	peek: r.query({ input: ById, output: Titles, access: { action: 'notes.read', on: 'note', from: 'id' }, sql: 'read' })
		.handle(async ({ ctx }) => {
			if ((await ctx.db.target.get()).trashed) return { titles: [] }
			return { titles: (await ctx.sql(Title)`select title from notes order by title`).map((row) => row.title) }
		}),
	organizationIds: r.query({
		input: InOrganization,
		output: Organizations,
		access: { action: 'notes.read', in: 'organization', from: 'organizationId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			ids: (await ctx.sql(OrganizationId)`select distinct organization_id from notes order by organization_id`).map((row) => row.organizationId),
		})),
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
				return { id: note.id, title: note.title, trashed: note.trashed }
			}),
	}),
})

/** Removes every trashed note; a retried attempt lists again, so it removes nothing twice. */
export const purge = app.cron('0 3 * * *', { actions: ['notes.read', 'notes.write'] })
	.handle(async ({ ctx }) => {
		const trashed = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list({ where: [['trashed', '=', true]] })
		await ctx.transaction(async (tx) => {
			for (const note of trashed.items) {
				await tx.db.on(await ctx.ref('notes.write', 'note', note.id)).remove({ expectVersion: note.version })
			}
		})
	})
