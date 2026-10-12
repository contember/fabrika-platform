import { z } from 'zod/v4'

export const Me = z.strictObject({ id: z.string(), label: z.string() })
export const Readable = z.strictObject({ all: z.boolean(), values: z.array(z.string()) })
