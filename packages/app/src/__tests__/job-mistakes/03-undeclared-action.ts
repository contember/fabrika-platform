import { scoped } from '@fabrika/db'
import { implement } from '../../implement/implement'
import { contract } from '../fixtures/jobs-notes/fabrika.contract'
import { tables } from '../fixtures/scoped-notes/src/db/tables'

export const app = implement(contract, {
	database: scoped(tables),
	deps: () => ({}),
	handlers: () => ({
		api: { notes: { list: () => ({ items: [] }) } },
		jobs: {
			purge: () => {},
			sweep: () => {},
			flaky: async ({ ctx }) => {
				// mistake: flaky declares notes.read only
				await ctx.ref('notes.delete', 'note', 'n1')
			},
		},
	}),
})
