import type { ZeropsServiceEnv } from './types'

const invalid = (): never => {
	throw new Error('zerops: invalid service environment response')
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): string => {
	if (typeof value !== 'string' || value.trim() === '') return invalid()
	return value
}

/** Parse at the raw HTTP boundary, before permissive legacy readers can coerce a malformed field. */
export function parseServiceEnvResponse(value: unknown, serviceId: string): ZeropsServiceEnv[] {
	if (!isRecord(value) || !Array.isArray(value['items']) || serviceId.trim() === '') return invalid()
	const ids = new Set<string>()
	const keys = new Set<string>()
	return value['items'].map((entry: unknown) => {
		if (!isRecord(entry)) return invalid()
		const id = nonempty(entry['id'])
		const key = nonempty(entry['key'])
		const content = entry['content']
		if (typeof content !== 'string' || ids.has(id) || keys.has(key)) return invalid()
		ids.add(id)
		keys.add(key)
		const association = Object.hasOwn(entry, 'serviceStackId') ? nonempty(entry['serviceStackId']) : undefined
		if (association !== undefined && association !== serviceId) return invalid()
		const type = Object.hasOwn(entry, 'type') ? nonempty(entry['type']) : undefined
		const sensitive = Object.hasOwn(entry, 'sensitive') ? entry['sensitive'] : undefined
		if (Object.hasOwn(entry, 'sensitive') && typeof sensitive !== 'boolean') return invalid()
		return {
			id,
			key,
			content,
			...(association === undefined ? {} : { serviceStackId: association }),
			...(type === undefined ? {} : { type }),
			...(typeof sensitive === 'boolean' ? { sensitive } : {}),
		}
	})
}
