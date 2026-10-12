// The probe's task endpoints on the paved road: `assign` updates the one column its action writes, `close` and
// `update` write a subset of the columns, and `mine` lists the caller's tasks across every project of an org.

import { ConflictError, fromRow } from '@fabrika/app'
import type { RowOf } from '@fabrika/db/tables'
import { app } from '../app-kit'
import type { tables } from '../db/tables'
import { AssignTask, CloseTask, MyTasks, NewTask, Saved, Task, TaskById, TaskPage, UpdateTask } from '../schemas'
import { canClose, isOverdue } from './logic'

const toTask = (row: RowOf<typeof tables, 'tasks'>) => fromRow(Task, row)

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: TaskById, output: Task, access: { action: 'tasks.read', on: 'task', from: 'id' } })
		.handle(async ({ ctx }) => toTask(await ctx.db.target.get())),
	mine: r.query({ input: MyTasks, output: TaskPage, access: { action: 'tasks.read', over: 'org' } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.within.tasks.list({
				where: [['assignee', '=', ctx.principal.id], ['status', '<>', 'done']],
				orderBy: [['due_on', 'asc']],
				limit: input.limit,
				after: input.after,
			})
			return { items: page.items.map(toTask), next: page.next }
		}),
	create: r.mutation({ input: NewTask, output: Saved, access: { action: 'tasks.write', in: 'project', from: 'projectId' } })
		.handle(({ input, ctx }) => ctx.db.target.tasks.insert({ title: input.title, status: 'open', due_on: input.dueOn ?? null })),
	update: r.mutation({ input: UpdateTask, output: Saved, access: { action: 'tasks.write', on: 'task', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ title: input.title, due_on: input.dueOn }, { expectVersion: input.expectVersion })),
	assign: r.mutation({ input: AssignTask, output: Saved, access: { action: 'tasks.assign', on: 'task', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ assignee: input.assignee }, { expectVersion: input.expectVersion })),
	close: r.mutation({ input: CloseTask, output: Saved, access: { action: 'tasks.write', on: 'task', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const task = await ctx.db.target.getForUpdate()
			if (!canClose(task.status)) {
				throw new ConflictError('only a task in progress closes')
			}
			return ctx.db.target.update({ status: 'done', closed_at: new Date().toISOString(), overdue: false }, {
				expectVersion: input.expectVersion,
			})
		}),
}))

/** Marks every task past its due day, across every org: a keyset page at a time, each write in the attempt's transaction. */
export const markOverdue = app.cron('15 * * * *', { actions: ['tasks.read', 'tasks.write'], scope: 'app' })
	.handle(async ({ ctx }) => {
		const today = new Date().toISOString().slice(0, 10)
		const tasks = ctx.db.over(ctx.within('tasks.read', 'org')).tasks
		let after: string | undefined
		do {
			const page = await tasks.list({ where: [['overdue', '=', false], ['status', '<>', 'done'], ['due_on', '<', today]], limit: 100, after })
			for (const task of page.items.filter((item) => isOverdue(item.status, item.due_on, today))) {
				const ref = await ctx.ref('tasks.write', 'task', task.id)
				await ctx.transaction((tx) => tx.db.on(ref).update({ overdue: true }, { expectVersion: task.version }))
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
