import { z } from 'zod/v4'

export const ById = z.strictObject({ id: z.uuid() })

export const Note = z.strictObject({
	id: z.uuid(),
	title: z.string().min(1).max(200),
	body: z.string().max(100000).nullable(),
	version: z.int().nonnegative(),
	rating: z.number().positive().max(5).optional(),
	sku: z.string().regex(/^[A-Z0-9-]+$/),
	updatedAt: z.iso.datetime(),
})

export const NoteList = z.array(Note).max(500)

export const Me = z.strictObject({ email: z.email() })

export const Deleted = z.strictObject({ deleted: z.uuid() })

export const NewWorkspace = z.strictObject({ name: z.string().min(1).max(80) })

export const Import = z.strictObject({ workspaceId: z.uuid(), notes: z.array(Note).min(1).max(1000) })

export const Imported = z.strictObject({ imported: z.int().nonnegative() })

export const Push = z.strictObject({ ref: z.string(), compare: z.url() })

export const Contact = z.strictObject({ email: z.email(), message: z.string().max(5000) })
