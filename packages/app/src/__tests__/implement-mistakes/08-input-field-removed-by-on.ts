import { implement } from '@fabrika/app/implement'
import { contract } from '../fixtures/implement/fabrika.contract'
import { noteDatabase, type NoteRow, notesStore } from '../fixtures/implement/stores'

const rows = new Map<string, NoteRow>()

// the handler reads the id the access form removed from the input
export const app = implement(contract, {
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
				remove: ({ input, ctx }) => {
					notes.remove(ctx.target)
					// mistake: the id is the checked ctx.target now, not an input field
					return { deleted: input.id }
				},
			},
		},
		machine: {
			importNotes: ({ input }) => ({ imported: input.titles.length }),
		},
	}),
})
