// The inputs and outputs of the endpoints, and the limits the SPA shows. The shell and the SPA import them.

import { z } from 'zod/v4'

export const MAX_ATTACHMENT_BYTES = 1048576
export const MAX_ATTACHMENTS_PER_NOTE = 10

export const Note = z.strictObject({ id: z.uuid(), title: z.string(), trashed: z.boolean(), version: z.int() })
export const NoteList = z.strictObject({ items: z.array(Note) })
export const ById = z.strictObject({ id: z.uuid() })
export const Versioned = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const NewNote = z.strictObject({ workspaceId: z.string().min(1).max(100), title: z.string().min(1).max(200) })
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Done = z.strictObject({ id: z.uuid() })
export const InviteGuest = z.strictObject({
	workspaceId: z.string().min(1).max(100),
	email: z.email(),
	label: z.string().max(200).optional(),
	message: z.string().max(1000).optional(),
	resend: z.boolean().optional(),
})
export const Invited = z.strictObject({ invitationId: z.string() })
