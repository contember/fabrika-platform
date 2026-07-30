/** Read an own property from an untrusted value. */
export function prop(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) {
		return undefined
	}
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

export function stringField(value: unknown, key: string): string | undefined {
	const field = prop(value, key)
	return typeof field === 'string' ? field : undefined
}

export function stringArrayField(value: unknown, key: string): string[] | undefined {
	const field = prop(value, key)
	if (!Array.isArray(field)) {
		return undefined
	}
	const values: string[] = []
	for (const item of field) {
		if (typeof item !== 'string') {
			return undefined
		}
		values.push(item)
	}
	return values
}
