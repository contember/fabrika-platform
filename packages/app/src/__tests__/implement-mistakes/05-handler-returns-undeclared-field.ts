import { implement } from '../../implement/implement'
import { contract } from '../fixtures/implement/fabrika.contract'
import { noteDatabase, type NoteRow, notesStore } from '../fixtures/implement/stores'

const rows = new Map<string, NoteRow>()

// the handler returns the whole row, with fields the output does not declare
export const app = implement(contract, {
	database: noteDatabase(rows),
	deps: (_env, { capabilities }) => ({ notes: notesStore(capabilities, rows) }),
	handlers: ({ notes }) => ({
		api: {
			me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
			notes: {
				list: ({ ctx }) => ({ items: notes.list(ctx.within).map((note) => ({ id: note.id, title: note.title })) }),
				// mistake: the whole row is returned, internalScore and workspaceId included
				get: ({ ctx }) => notes.get(ctx.target),
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
