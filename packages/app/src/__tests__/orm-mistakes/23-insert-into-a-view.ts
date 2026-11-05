import { z } from 'zod/v4'
import { app } from '../probe-tasks/src/app-kit'
import { Saved } from '../probe-tasks/src/schemas'

export const projects = app.group({ callers: ['human'] }, (r) => ({
	count: r.mutation({ input: z.strictObject({ id: z.string() }), output: Saved, access: { action: 'tasks.write', on: 'project', from: 'id' } })
		.handle(({ ctx }) =>
			// mistake: a view's rows come from the tables it reads, so no site inserts into one
			ctx.db.target.project_task_counts.insert({ tasks: 1 })
		),
}))
