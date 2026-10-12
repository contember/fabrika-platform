import { z } from 'zod/v4'

export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const ById = z.strictObject({ id: z.uuid() })
export const AssignDeal = z.strictObject({
	id: z.uuid(),
	expectVersion: z.int().positive(),
	newOwner: z.string().min(1).max(200),
})
export const Owner = z.strictObject({ owner: z.nullable(z.string()), ownerLabel: z.nullable(z.string()) })
export const Team = z.strictObject({ members: z.array(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()) })) })
export const Candidate = z.strictObject({ id: z.uuid(), principalId: z.string().min(1).max(200) })
export const Found = z.strictObject({ member: z.nullable(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()) })) })
