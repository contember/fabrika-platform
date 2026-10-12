import { fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Name, Next, Page, Person, Saved } from '../schemas'

const Task = z.strictObject({
	id: z.uuid(),
	dealId: z.uuid(),
	title: z.string(),
	dueOn: z.iso.date(),
	assignee: z.string(),
	assigneeLabel: z.string(),
	done: z.boolean(),
	overdue: z.boolean(),
	version: z.int(),
})
const TaskPage = z.strictObject({ items: z.array(Task), next: Next })
const NewTask = z.strictObject({ dealId: z.uuid(), title: Name, dueOn: z.iso.date(), assignee: z.nullable(Person) })
const CompleteTask = z.strictObject({ id: z.uuid(), done: z.boolean(), expectVersion: z.int().positive() })

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: Page, output: TaskPage, access: { action: 'crm.read', over: 'deal' } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.within.tasks.list({ orderBy: [['due_on', 'asc']], after: input.after })
			return { items: page.items.map((row) => fromRow(Task, row)), next: page.next }
		}),
	create: r.mutation({ input: NewTask, output: Saved, access: { action: 'tasks.write', in: 'deal', from: 'dealId' } })
		.handle(({ input, ctx }) => {
			const assignee = input.assignee ?? { principalId: ctx.principal.id, label: ctx.principal.label }
			return ctx.db.target.tasks.insert({ title: input.title, due_on: input.dueOn, assignee: assignee.principalId, assignee_label: assignee.label })
		}),
	complete: r.mutation({ input: CompleteTask, output: Saved, access: { action: 'tasks.write', on: 'task', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ done: input.done }, { expectVersion: input.expectVersion })),
}))

/** Marks open tasks past their due day, at most 500 an hour; the next run takes the rest, and a retry lists again. */
export const overdue = app.cron('15 * * * *', { actions: ['crm.read', 'tasks.write'], scope: 'app', timeout: '5m', retries: 2 })
	.handle(async ({ ctx }) => {
		const today = new Date().toISOString().slice(0, 10)
		const due = await ctx.db.over(ctx.within('crm.read', 'deal')).tasks.list({
			where: [['done', '=', false], ['overdue', '=', false], ['due_on', '<', today]],
			limit: 500,
		})
		for (const task of due.items) {
			const ref = await ctx.ref('tasks.write', 'task', task.id)
			await ctx.transaction((tx) => tx.db.on(ref).update({ overdue: true }, { expectVersion: task.version }))
		}
	})
