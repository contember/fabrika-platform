import { z } from 'zod/v4'
import { app } from '../probe-tasks/src/app-kit'

export const projects = app.group({ callers: ['human'] }, (r) => ({
	reset: r.mutation({
		input: z.strictObject({}),
		output: z.strictObject({ ok: z.boolean() }),
		access: { member: true },
		// mistake: no site writes a view, and this one declares project_task_counts unscoped: 'write'
		unscoped: { project_task_counts: 'write' },
	})
		.handle(() => ({ ok: true })),
}))
