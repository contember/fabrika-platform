// A mutation that kicks a job: `enqueue` starts a run of `deliver` once its transaction committed; `refuse` declares
// the same kick and throws after its insert, so its transaction rolls back and nothing is kicked; `peek` is a query.

import { app } from './src/app-kit'
import { deliver } from './src/deliver'
import { outbox } from './src/outbox'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { outbox }),
	jobs: { deliver },
}))
