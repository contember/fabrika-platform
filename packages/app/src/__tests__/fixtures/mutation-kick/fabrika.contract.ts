// A mutation that kicks a job: `enqueue` starts a run of `deliver` once its transaction committed; `refuse` declares
// the same kick and throws after its insert, so its transaction rolls back and nothing is kicked; `peek` is a query.
// `post` declares `kicks` and kicks through `ctx.kick` when its handler asks; the job `sweep` kicks `deliver`.

import { app } from './src/app-kit'
import { deliver, sweep } from './src/deliver'
import { outbox } from './src/outbox'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { outbox }),
	jobs: { deliver, sweep },
}))
