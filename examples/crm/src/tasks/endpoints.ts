import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { picked } from '../orgs/logic'
import { Name, Next, Page, PrincipalId, Saved } from '../schemas'

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
const NewTask = z.strictObject({ dealId: z.uuid(), title: Name, dueOn: z.iso.date(), assignee: PrincipalId.optional() })
const CompleteTask = z.strictObject({ id: z.uuid(), done: z.boolean(), expectVersion: z.int().positive() })

export const tasks = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: Page, output: TaskPage, access: { action: 'crm.read', over: 'deal' } })
		.handle(async ({ input, ctx }) => fromPage(Task, await ctx.db.within.tasks.list({ orderBy: [['due_on', 'asc']], after: input.after }))),
	create: r.mutation({ input: NewTask, output: Saved, access: { action: 'tasks.write', in: 'deal', from: 'dealId' } })
		.handle(async ({ input, ctx }) => {
			const assignee = input.assignee === undefined
				? { principalId: ctx.principal.id, label: ctx.principal.label }
				: picked(await ctx.members.get(input.assignee), 'assignee')
			return ctx.db.target.tasks.insert({ title: input.title, due_on: input.dueOn, assignee: assignee.principalId, assignee_label: assignee.label })
		}),
	complete: r.mutation({ input: CompleteTask, output: Saved, access: { action: 'tasks.write', on: 'task', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.update({ done: input.done }, { expectVersion: input.expectVersion })),
}))

/** Marks every open task past its due day, hourly; each is re-read under its lock, so a concurrent change is skipped. */
export const overdue = app.cron('15 * * * *', { actions: ['crm.read', 'tasks.write'], limits: { timeoutMs: 300000 }, retries: 2 })
	.handle(async ({ ctx }) => {
		const today = new Date().toISOString().slice(0, 10)
		const open = ctx.db.over(ctx.within('crm.read', 'deal')).tasks
		let after: string | undefined
		do {
			const page = await open.list({ where: [['done', '=', false], ['overdue', '=', false], ['due_on', '<', today]], limit: 100, after })
			for (const task of page.items) {
				const ref = await ctx.ref('tasks.write', 'task', task.id)
				await ctx.transaction(async (tx) => {
					const locked = await tx.db.on(ref).getForUpdate()
					if (!locked.done && !locked.overdue) await tx.db.on(ref).update({ overdue: true }, { expectVersion: locked.version })
				})
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
