import { z } from 'zod'
import type { ZeropsServiceEnv } from './types'

const invalid = (): never => {
	throw new Error('zerops: invalid service environment response')
}
const nonemptySchema = z.string().refine((value) => value.trim() !== '')
const serviceEnvEntrySchema = z.object({
	id: nonemptySchema,
	key: nonemptySchema,
	content: z.string(),
	serviceStackId: nonemptySchema.optional(),
	type: nonemptySchema.optional(),
	sensitive: z.boolean().optional(),
}).superRefine((entry, ctx) => {
	if (Object.values(entry).some((value) => value === undefined)) ctx.addIssue({ code: 'custom', message: 'present fields must have values' })
})
const serviceEnvResponseSchema = z.object({
	items: z.array(z.preprocess((value) => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
		return {
			id: Reflect.get(value, 'id'),
			key: Reflect.get(value, 'key'),
			content: Reflect.get(value, 'content'),
			...(Object.hasOwn(value, 'serviceStackId') ? { serviceStackId: Reflect.get(value, 'serviceStackId') } : {}),
			...(Object.hasOwn(value, 'type') ? { type: Reflect.get(value, 'type') } : {}),
			...(Object.hasOwn(value, 'sensitive') ? { sensitive: Reflect.get(value, 'sensitive') } : {}),
		}
	}, serviceEnvEntrySchema)),
})

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
		return entry
	})
}
