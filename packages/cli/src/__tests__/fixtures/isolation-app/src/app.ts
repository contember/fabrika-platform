// The application: handlers reach rows only through the stores, with the capabilities `ctx` hands them.

import { implement } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'
import { database } from './db/database'
import { comments, notes, organizations, workspaces } from './db/stores/notes'

export default implement(contract, {
	database,
	deps: () => ({}),
	handlers: () => ({
		api: {
			organizations: {
				get: async ({ ctx }) => {
					const organization = await organizations.get(ctx.target)
					return { id: organization.id, name: organization.name }
				},
			},
			workspaces: {
				list: async ({ ctx }) => ({ items: await workspaces.list(ctx.within) }),
			},
			notes: {
				get: async ({ ctx }) => {
					const note = await notes.get(ctx.target)
					return { id: note.id, title: note.title }
				},
				list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
				create: async ({ input, ctx }) => ({ id: (await notes.create(ctx.target, input.title)).id }),
				rename: async ({ input, ctx }) => ({ id: (await notes.rename(ctx.target, input.title, input.expectVersion)).id }),
				comments: async ({ ctx }) => ({ items: await comments.list(ctx.target) }),
			},
		},
		ops: {
			count: async ({ ctx }) => {
				const [row] = await notes.count(ctx.within)
				return { count: row?.count ?? '0' }
			},
		},
	}),
})
