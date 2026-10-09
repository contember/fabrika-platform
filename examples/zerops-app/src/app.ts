// The handlers of fabrika.contract.ts. Each one reaches rows only through the store, with the capability its access
// form minted; the file endpoints of `attachments` are the framework's and need no handler here.

import { implement } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'
import { database } from './db/database'
import { notes } from './db/stores/notes'

export default implement(contract, {
	database,
	deps: () => ({}),
	handlers: () => ({
		api: {
			notes: {
				list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
				get: async ({ ctx }) => {
					const note = await notes.get(ctx.target)
					return { id: note.id, title: note.title, trashed: note.trashed, version: note.version }
				},
				create: async ({ input, ctx }) => ({ id: (await notes.create(ctx.target, input.title)).id }),
				trash: async ({ input, ctx }) => ({ id: (await notes.trash(ctx.target, input.expectVersion)).id }),
				remove: async ({ ctx }) => {
					await notes.remove(ctx.target)
					return { id: ctx.target.value }
				},
			},
		},
		jobs: {
			// A retried attempt lists again, so a note an earlier attempt deleted is not deleted twice.
			purge: async ({ ctx }) => {
				for (const note of await notes.trashed(ctx.within('notes.read', 'workspace'))) {
					await notes.remove(await ctx.ref('notes.delete', 'note', note.id))
				}
			},
		},
	}),
})
