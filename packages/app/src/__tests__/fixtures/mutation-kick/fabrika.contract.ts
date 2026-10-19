// A mutation that kicks a job: `enqueue` kicks `deliver`, whose run starts once its transaction committed; `refuse`
// kicks it too and throws after its insert, so its transaction rolls back and nothing is kicked; `peek` is a query.
// `post` kicks only when its handler asks for it; the job `sweep` kicks `deliver`.

import { app } from './src/app-kit'
import { deliver, sweep } from './src/deliver'
import { outbox } from './src/outbox'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { outbox }),
	jobs: { deliver, sweep },
}))
