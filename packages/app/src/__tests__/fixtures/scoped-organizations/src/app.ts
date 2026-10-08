// The application: each handler reaches rows through its capability and answers where that capability says the
// object lies. Each call builds its own `scoped(tables)`, because `boot` binds a layer once.

import { implement } from '@fabrika/app/implement'
import { type Ref, scoped, type Within } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

/** Where the tests pause a handler between the access check and its store call. */
export interface Hooks {
	beforeStore: () => Promise<void>
}

export function organizationsApp(hooks: Hooks) {
	const database = scoped(tables)
	const notes = database.defineStore('notes', (t) => ({
		list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
		get: (note: Ref<'note', 'notes.read'>) => t.get(note),
		create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
	}))
	return implement(contract, {
		database,
		deps: () => ({}),
		handlers: () => ({
			api: {
				notes: {
					list: async ({ ctx }) => {
						await hooks.beforeStore()
						return { items: await notes.list(ctx.within) }
					},
					where: async ({ ctx }) => {
						const note = await notes.get(ctx.target)
						return { id: note.id, workspace: ctx.target.chain.get('workspace') ?? '', organization: ctx.target.chain.get('organization') ?? '' }
					},
					create: async ({ input, ctx }) => {
						await hooks.beforeStore()
						const created = await notes.create(ctx.target, input.title)
						return { id: created.id, workspace: ctx.target.value, organization: ctx.target.chain.get('organization') ?? '' }
					},
				},
			},
		}),
	})
}
