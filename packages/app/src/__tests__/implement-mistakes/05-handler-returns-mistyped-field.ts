import { implement } from '../../implement/implement'
import { contract } from '../fixtures/implement/fabrika.contract'
import { noteDatabase, type NoteRow, notesStore } from '../fixtures/implement/stores'

const rows = new Map<string, NoteRow>()

// a handler's return is checked against the declared output: a mistyped field is a type error
export const app = implement(contract, {
	database: noteDatabase(rows),
	deps: (_env, { capabilities }) => ({ notes: notesStore(capabilities, rows) }),
	handlers: ({ notes }) => ({
		api: {
			me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
			notes: {
				list: ({ ctx }) => ({ items: notes.list(ctx.within).map((note) => ({ id: note.id, title: note.title })) }),
				// mistake: the score goes out as the title, which Note declares a string
				get: ({ ctx }) => ({ id: ctx.target.value, title: notes.get(ctx.target).internalScore }),
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
			importNotes: ({ input }) => ({ imported: input.titles.length }),
		},
	}),
})
