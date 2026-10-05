import { z } from 'zod'

export const idResponseSchema = z.object({ id: z.string().min(1) })
export const machineKeyResponseSchema = z.object({ apiKey: z.string().min(1) })
export const itemsResponseSchema = z.object({ items: z.array(z.unknown()) })
export const rpcResponseSchema = z.object({ error: z.undefined(), result: z.unknown() })

// These lists select relevant entries before requiring their identifiers.
export const healthFixtureSchema = z.object({ httpChecks: z.array(z.unknown()).catch([]) }).catch({ httpChecks: [] })
export const healthCheckFixtureSchema = z.object({ path: z.string(), id: z.unknown() })
export const alertsFixtureSchema = z.object({ channels: z.array(z.unknown()).catch([]) }).catch({ channels: [] })
export const alertChannelFixtureSchema = z.object({ targetDisplay: z.string(), id: z.unknown() })
export const sourceFixtureSchema = z.object({ appId: z.string(), environment: z.string(), id: z.unknown() })
