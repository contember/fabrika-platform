import { z } from 'zod/v4'

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const
export const MAX_ATTACHMENT_BYTES = 5242880
export const MAX_ATTACHMENTS_PER_DEAL = 20

export const Stage = z.enum(DEAL_STAGES)
export const Name = z.string().min(1).max(200)
export const OptionalText = z.string().max(500).optional()
export const ClearableText = z.nullable(z.string().max(500))
export const MaybeText = z.nullable(z.string())
export const ScopeValue = z.string().min(1).max(100)
export const Cursor = z.string().max(500)
export const Next = z.nullable(z.string())
export const PrincipalId = z.string().min(1).max(200)

export const ById = z.strictObject({ id: z.uuid() })
export const Page = z.strictObject({ after: Cursor.optional() })
export const Versioned = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Done = z.strictObject({ id: z.uuid() })
