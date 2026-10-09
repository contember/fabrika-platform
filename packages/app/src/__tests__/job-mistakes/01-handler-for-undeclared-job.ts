import { implement } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fixtures/jobs-notes/fabrika.contract'
import { tables } from '../fixtures/scoped-notes/src/db/tables'

// a background loop added as a job handler without declaring the job
export const app = implement(contract, {
	database: scoped(tables),
	deps: () => ({}),
	handlers: () => ({
		api: { notes: { list: () => ({ items: [] }) } },
		jobs: {
			purge: () => {},
			sweep: () => {},
			flaky: () => {},
			// mistake: reindex is not a job of the contract
			reindex: () => {},
		},
	}),
})
