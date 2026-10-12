import { app } from './src/app-kit'
import { markOverdue, tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { tasks }),
	health: c.health('/healthz'),
	jobs: { markOverdue },
}))
