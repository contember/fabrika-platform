// The application: handlers reach rows only through the stores, with the capabilities `ctx` hands them.

import { implement } from '@fabrika/app/implement'
import type { Ref } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { database as applicationDatabase } from './db/database'
import { notes } from './db/stores/notes'

/** Where the tests pause a handler between the access check and its first query. */
export interface Hooks {
	readonly beforeRead: (id: string) => Promise<void>
	readonly whileKept: () => Promise<void>
}

/** The edit the data layer must refuse: capabilities cached in a module, to serve the next caller faster. */
const kept: Ref<'note', 'notes.read'>[] = []

export function scopedNotesApp(hooks: Hooks, database: typeof applicationDatabase = applicationDatabase) {
	return implement(contract, {
		database,
		deps: () => ({}),
		handlers: () => ({
			api: {
				notes: {
					list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }),
					get: async ({ ctx }) => {
						await hooks.beforeRead(ctx.target.value)
						const note = await notes.get(ctx.target)
						return { id: note.id, title: note.title }
					},
					create: async ({ input, ctx }) => {
						const created = await notes.create(ctx.target, input.title)
						return { id: created.id }
					},
					keep: async ({ ctx }) => {
						kept.push(ctx.target)
						await hooks.whileKept()
						return { kept: true }
					},
					reuse: async () => {
						const cached = kept[kept.length - 1]
						if (cached === undefined) {
							throw new Error('nothing kept')
						}
						const note = await notes.get(cached)
						return { id: note.id, title: note.title }
					},
				},
			},
		}),
	})
}
