import { z } from 'zod'
import type { ZeropsServiceEnv } from './types'

const invalid = (): never => {
	throw new Error('zerops: invalid service environment response')
}
const nonemptySchema = z.string().refine((value) => value.trim() !== '')

/** One user-data record as the platform sends it, before `withoutSensitiveContent`. */
interface RawServiceEnv {
	readonly id: string
	readonly key: string
	readonly content: string
	readonly serviceStackId?: string | undefined
	readonly type?: string | undefined
	readonly sensitive: boolean
}

/**
 * Drop a sensitive record's `content`, whatever it says.
 *
 * Zerops answers `REDACTED` outside sudo mode and the real value inside it (measured 2026-10-15), so the
 * same call reads differently depending on the token. Dropping it here makes every caller behave the
 * same for both, and no caller can compare, merge or leak a secret it read back.
 */
export const withoutSensitiveContent = (raw: RawServiceEnv): ZeropsServiceEnv => {
	const record = {
		id: raw.id,
		key: raw.key,
		...(raw.serviceStackId === undefined ? {} : { serviceStackId: raw.serviceStackId }),
		...(raw.type === undefined ? {} : { type: raw.type }),
	}
	return raw.sensitive ? { ...record, sensitive: true } : { ...record, sensitive: false, content: raw.content }
}

/** The value of a record fabrika can read: absent when there is no record or it is sensitive. */
export const readableContent = (record: ZeropsServiceEnv | undefined): string | undefined =>
	record === undefined || record.sensitive ? undefined : record.content

const serviceEnvEntrySchema = z.object({
	id: nonemptySchema,
	key: nonemptySchema,
	content: z.string(),
	serviceStackId: nonemptySchema.optional(),
	type: nonemptySchema.optional(),
	sensitive: z.boolean(),
}).superRefine((entry, ctx) => {
	if (Object.values(entry).some((value) => value === undefined)) ctx.addIssue({ code: 'custom', message: 'present fields must have values' })
})
const serviceEnvResponseSchema = z.object({ items: z.array(serviceEnvEntrySchema) })

/** Parse at the raw HTTP boundary, before permissive legacy readers can coerce a malformed field. */
export function parseServiceEnvResponse(value: unknown, serviceId: string): ZeropsServiceEnv[] {
	const result = serviceEnvResponseSchema.safeParse(value)
	if (!result.success || serviceId.trim() === '') return invalid()
	const ids = new Set<string>()
	const keys = new Set<string>()
	return result.data.items.map((entry) => {
		const { id, key, serviceStackId } = entry
		if (ids.has(id) || keys.has(key)) return invalid()
		ids.add(id)
		keys.add(key)
		if (serviceStackId !== undefined && serviceStackId !== serviceId) return invalid()
		return withoutSensitiveContent(entry)
	})
}
