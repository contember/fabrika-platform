// The fixture application: one handler per procedure of `contract.ts`.

import { implement } from '../../../implement/implement'
import { contract } from './fabrika.contract'
import { noteDatabase, type NoteRow, notesStore } from './stores'

export function notesApp(rows: Map<string, NoteRow>) {
	return implement(contract, {
		database: noteDatabase(rows),
		deps: (_env, { capabilities }) => ({ notes: notesStore(capabilities, rows) }),
		handlers: ({ notes }) => ({
			api: {
				me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
				notes: {
					list: ({ ctx }) => ({ items: notes.list(ctx.within).map((note) => ({ id: note.id, title: note.title })) }),
					get: ({ ctx }) => {
						const note = notes.get(ctx.target)
						return { id: note.id, title: note.title }
					},
					create: ({ input, ctx }) => {
						const note = notes.insert(ctx.target, input.title)
						return { id: note.id, title: note.title }
					},
					remove: ({ ctx }) => {
						notes.remove(ctx.target)
						return { deleted: ctx.target.value }
					},
				},
			},
			machine: {
				importNotes: ({ input, ctx }) => {
					for (const title of input.titles) {
						notes.insert(ctx.target, title)
					}
					return { imported: input.titles.length }
				},
			},
		}),
	})
}
