import { z } from 'zod/v4'

export const Join = z.strictObject({ email: z.email().max(200), challengeToken: z.string().max(4096) })
