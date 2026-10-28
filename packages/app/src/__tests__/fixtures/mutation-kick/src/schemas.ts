import { z } from 'zod/v4'

export const Message = z.strictObject({ body: z.string().min(1).max(200) })
/** A message and the times, in epoch milliseconds, its delivery is kicked for. */
export const Reminder = z.strictObject({ body: z.string().min(1).max(200), at: z.array(z.int()).max(5) })
export const Queued = z.strictObject({ id: z.string() })
export const Waiting = z.strictObject({ waiting: z.int() })
export const Delivered = z.strictObject({ body: z.string() })
