// What more than one slice and the SPA share; a slice's own inputs and outputs live in its endpoints.ts.

import { z } from 'zod/v4'

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const
export const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting'] as const
export const MAX_ATTACHMENT_BYTES = 5242880
export const MAX_ATTACHMENTS_PER_DEAL = 20

export const Stage = z.enum(DEAL_STAGES)
export const ActivityKind = z.enum(ACTIVITY_KINDS)
export const Name = z.string().min(1).max(200)
export const OptionalText = z.nullable(z.string().max(500))
export const MaybeText = z.nullable(z.string())
export const ScopeValue = z.string().min(1).max(100)
export const Cursor = z.string().max(500)
export const Next = z.nullable(z.string())
export const Person = z.strictObject({ principalId: z.string().min(1).max(200), label: z.string().min(1).max(200) })

export const ById = z.strictObject({ id: z.uuid() })
export const Page = z.strictObject({ after: Cursor.optional() })
export const Versioned = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Done = z.strictObject({ id: z.uuid() })
