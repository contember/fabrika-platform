import { implement } from '../../implement/implement'
import { contract } from '../fixtures/implement/fabrika.contract'
import { noteDatabase, type NoteRow, notesStore } from '../fixtures/implement/stores'

const rows = new Map<string, NoteRow>()

// a declared procedure without a handler
export const app = implement(contract, {
	database: noteDatabase(rows),
	deps: (_env, { capabilities }) => ({ notes: notesStore(capabilities, rows) }),
	handlers: ({ notes }) => ({
		api: {
			me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
			// mistake: remove has no handler
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
			},
		},
		machine: {
			importNotes: ({ input }) => ({ imported: input.titles.length }),
		},
	}),
})
