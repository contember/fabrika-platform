import { z } from 'zod/v4'

export const ById = z.strictObject({ id: z.uuid() })
export const Versioned = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const InWorkspace = z.strictObject({ workspaceId: z.string().min(1) })
export const Note = z.strictObject({ id: z.uuid(), title: z.string(), trashed: z.boolean() })
export const Notes = z.strictObject({ items: z.array(Note) })
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Titles = z.strictObject({ titles: z.array(z.string()) })
