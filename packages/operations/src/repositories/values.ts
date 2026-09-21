export function number(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error(`invalid numeric ${field}`)
	return parsed
}

export function parseObject(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value)
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('activity data is not an object')
	return Object.fromEntries(Object.entries(parsed))
}
