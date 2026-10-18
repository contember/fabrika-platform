import { z } from 'zod/v4'

export const Register = z.strictObject({
	email: z.email().max(200),
	name: z.string().min(1).max(200),
	website: z.optional(z.string().max(200)),
	challengeToken: z.string().max(4096),
})
export const Apply = z.strictObject({ email: z.email().max(200), challengeToken: z.string().max(4096) })
