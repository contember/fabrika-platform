import type { OperationsOperatorOptions } from './context.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function numeric(value: number | string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed)) throw new Error('invalid stored numeric value')
	return parsed
}

export function nullableNumeric(value: number | string | null): number | null {
	return value === null ? null : numeric(value)
}

export function now(options: OperationsOperatorOptions): number {
	return (options.now ?? Date.now)()
}
