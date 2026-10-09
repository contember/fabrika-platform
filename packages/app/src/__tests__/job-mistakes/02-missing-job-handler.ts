import { implement } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fixtures/jobs-notes/fabrika.contract'
import { tables } from '../fixtures/scoped-notes/src/db/tables'

export const app = implement(contract, {
	database: scoped(tables),
	deps: () => ({}),
	handlers: () => ({
		api: { notes: { list: () => ({ items: [] }) } },
		// mistake: flaky is declared and has no handler
		jobs: { purge: () => {}, sweep: () => {} },
	}),
})
