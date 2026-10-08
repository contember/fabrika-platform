// Every factory and method of the contract subset, with the options that change no shape.

import { z } from 'zod/v4'

export const ById = z.strictObject({ id: z.uuid() })

export const Priority = z.enum(['low', 'normal', 'high']).default('normal')

export const Status = z.literal(['open', 'done'])

export const Task = z.strictObject({
	id: z.uuid('not a task id'),
	title: z.string({ error: 'a title is text' }).min(1, { message: 'too short' }).max(200).describe('What the task is'),
	code: z.string().length(8).startsWith('T-').endsWith('x').includes('-', { message: 'needs a dash' }),
	slug: z.string().nonempty().regex(/^[a-z0-9-]+$/),
	contact: z.string().email(),
	reference: z.string().uuid(),
	link: z.string().url().nullish(),
	homepage: z.url().optional(),
	owner: z.email().max(320),
	estimate: z.number().positive().lte(1000).multipleOf(0.5),
	weight: z.number().gt(-10).lt(10).nullable(),
	offset: z.number().negative().gte(-100),
	balance: z.number().nonpositive().min(-1000000),
	count: z.int().nonnegative().max(100000),
	rank: z.number().int().min(1),
	done: z.boolean(),
	cleared: z.null(),
	status: Status,
	priority: Priority,
	labels: z.array(z.string().min(1)).max(20).default([]),
	tags: z.string().array().nonempty(),
	window: z.tuple([z.iso.date(), z.iso.date()]),
	steps: z.tuple([z.string()], z.int()),
	nothing: z.tuple([]),
	due: z.iso.datetime({ offset: false, local: false, precision: null }),
	remind: z.iso.time({ precision: null }).optional(),
	spent: z.iso.duration(),
	extra: z.record(z.string(), z.number()),
	scores: z.record(z.enum(['a', 'b']), z.int()),
	color: z.enum({ Red: 'red', Blue: 'blue' }),
	level: z.literal(3).or(z.literal(4)),
	note: z.optional(z.string()),
	parent: z.nullable(z.uuid()),
	settings: z.strictObject({ mode: z.string() }).default({ mode: 'plain' }),
})

export const Event = z.discriminatedUnion('type', [
	z.strictObject({ type: z.literal('created'), at: z.iso.datetime() }),
	z.strictObject({ type: z.literal('closed'), reason: z.union([z.literal('done'), z.literal('dropped')]) }),
])

export const Summary = z.strictObject({ id: z.uuid(), title: z.string(), rank: z.int() }).extend({ done: z.boolean() }).pick({
	id: true,
	title: true,
	done: true,
})

export const Draft = z.strictObject({ title: z.string(), body: z.string(), projectId: z.uuid() }).partial({ body: true })

export const Patch = z.strictObject({ id: z.uuid(), title: z.string(), body: z.string() }).omit({ body: true }).partial()

export const NewTask = z.strictObject({ projectId: z.uuid(), title: z.string().min(1), priority: Priority })

export const NewProject = z.strictObject({ name: z.string().min(1).max(80) })

export const Deleted = z.strictObject({ deleted: z.uuid() })

export const Feedback = z.strictObject({ email: z.email(), message: z.string().max(5000) })

export const Push = z.strictObject({ ref: z.string(), commits: z.array(z.strictObject({ id: z.string() })).max(50) })
