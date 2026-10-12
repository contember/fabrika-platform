import { app } from '../probe-tasks/src/app-kit'
import { AssignTask, Saved } from '../probe-tasks/src/schemas'

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	assign: r.mutation({ input: AssignTask, output: Saved, access: { action: 'tasks.assign', on: 'task', from: 'id' } })
		.handle(({ input, ctx }) =>
			// mistake: tasks.assign updates the assignee only; the title is the update action's
			ctx.db.target.update({ assignee: input.assignee, title: 'renamed' }, { expectVersion: input.expectVersion })
		),
}))
