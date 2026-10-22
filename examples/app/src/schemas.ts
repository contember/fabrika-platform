import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Me = z.strictObject({ id: z.string(), label: z.string() })
export const Readable = z.strictObject({ all: z.boolean(), values: z.array(z.string()) })

export const NewNote = z.strictObject({
	projectId: z.string().min(1),
	title: z.string().min(1).max(200),
	attachment: z.optional(file('attachments')),
})
export const InProject = z.strictObject({ projectId: z.string().min(1) })
export const OneNote = z.strictObject({ id: z.string().min(1) })
export const Created = z.strictObject({ id: z.uuid() })

const FileInfo = z.strictObject({
	id: z.uuid(),
	name: z.nullable(z.string()),
	type: z.string(),
	size: z.int(),
	status: z.enum(['pending', 'quarantined', 'live', 'rejected']),
})
const Note = z.strictObject({ id: z.uuid(), title: z.string(), reviewedAt: z.nullable(z.string()), attachment: z.nullable(FileInfo) })
export const NoteList = z.strictObject({ items: z.array(Note) })
