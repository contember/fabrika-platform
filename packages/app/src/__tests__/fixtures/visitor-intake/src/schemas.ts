import { z } from 'zod/v4'

export const Register = z.strictObject({ email: z.email().max(200), name: z.string().min(1).max(200) })
export const Resend = z.strictObject({ email: z.email().max(200) })
export const Verified = z.strictObject({ verifiedAt: z.string() })
export const Me = z.strictObject({ name: z.string(), email: z.string(), verified: z.boolean() })
