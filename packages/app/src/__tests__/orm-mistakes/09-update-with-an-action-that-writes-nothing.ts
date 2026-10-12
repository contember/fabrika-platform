import { app } from '../probe-tasks/src/app-kit'
import { CloseTask, Saved } from '../probe-tasks/src/schemas'

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: CloseTask, output: Saved, access: { action: 'tasks.read', on: 'task', from: 'id' } })
		.handle(({ input, ctx }) =>
			// mistake: tasks.read updates no column of tasks
			ctx.db.target.update({ title: 'touched' }, { expectVersion: input.expectVersion })
		),
}))
