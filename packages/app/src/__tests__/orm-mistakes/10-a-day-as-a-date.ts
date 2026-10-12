import { app } from '../probe-tasks/src/app-kit'
import { NewTask, Saved } from '../probe-tasks/src/schemas'

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({ input: NewTask, output: Saved, access: { action: 'tasks.write', in: 'project', from: 'projectId' } })
		.handle(({ input, ctx }) =>
			// mistake: a date column is a YYYY-MM-DD string, not a Date
			ctx.db.target.tasks.insert({ title: input.title, status: 'open', due_on: new Date() })
		),
}))
