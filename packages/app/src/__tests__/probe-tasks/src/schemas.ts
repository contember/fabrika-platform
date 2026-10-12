import { z } from 'zod/v4'

export const TaskStatus = z.enum(['open', 'doing', 'done'])
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Cursor = z.string().min(1).max(500)
export const PageLimit = z.int().min(1).max(100)

export const Task = z.strictObject({
	id: z.uuid(),
	projectId: z.string(),
	title: z.string(),
	status: TaskStatus,
	assignee: z.nullable(z.string()),
	dueOn: z.nullable(z.iso.date()),
	overdue: z.boolean(),
	version: z.int(),
})
export const TaskPage = z.strictObject({ items: z.array(Task), next: z.nullable(z.string()) })
export const TaskById = z.strictObject({ id: z.uuid() })
export const NewTask = z.strictObject({ projectId: z.string(), title: z.string().min(1).max(200), dueOn: z.optional(z.iso.date()) })
export const UpdateTask = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	title: z.optional(z.string().min(1).max(200)),
	dueOn: z.optional(z.nullable(z.iso.date())),
})
export const AssignTask = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive(), assignee: z.nullable(z.string().min(1).max(100)) })
export const CloseTask = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const MyTasks = z.strictObject({ orgId: z.string(), limit: z.optional(PageLimit), after: z.optional(Cursor) })
