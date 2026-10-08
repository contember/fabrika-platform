import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string().min(1).max(200) })
export const CreateNote = z.strictObject({ workspaceId: z.uuid(), title: z.string().min(1) })
