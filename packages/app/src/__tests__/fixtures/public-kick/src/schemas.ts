import { z } from 'zod/v4'

export const Signup = z.strictObject({ email: z.email().max(200), website: z.optional(z.string()) })
export const Application = z.strictObject({ email: z.email().max(200), challengeToken: z.string() })
export const Notice = z.strictObject({ email: z.email().max(200) })
export const Received = z.strictObject({ received: z.boolean() })
export const Welcomed = z.strictObject({ email: z.string() })
