import { z } from 'zod'
import type {
	IdentifiedOperatorIssueRow,
	OperatorIssueCursor,
	OperatorIssueSort,
	OperatorOccurrenceCursor,
	OperatorOccurrenceRow,
} from '../repositories.js'
import { badRequest } from './errors.js'
import { numeric } from './values.js'

const issueCursorSchema = z.object({ sort: z.enum(['new', 'frequency', 'recent']), value: z.number().int().safe(), id: z.string().min(1) })
const occurrenceCursorSchema = z.object({ receivedAt: z.number().int().safe(), id: z.string().min(1) })

export function boundedLimit(value: number | undefined): number {
	if (value === undefined) return 50
	if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw badRequest('limit must be between 1 and 100')
	return value
}

export function offsetCursor(value: string | null): number {
	if (value === null || value === '') return 0
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw badRequest('invalid cursor')
	return parsed
}

export function issueCursor(value: string | undefined, sort: OperatorIssueSort): OperatorIssueCursor | undefined {
	if (value === undefined || value === '') return undefined
	const parsed = issueCursorSchema.safeParse(decodedCursor(value))
	if (!parsed.success || parsed.data.sort !== sort) throw badRequest('invalid cursor')
	return { value: parsed.data.value, id: parsed.data.id }
}

export function encodeIssueCursor(row: IdentifiedOperatorIssueRow, sort: OperatorIssueSort): string {
	const value = sort === 'new'
		? numeric(row.first_seen)
		: sort === 'frequency'
		? numeric(row.occurrence_count)
		: numeric(row.last_seen)
	return encodeURIComponent(JSON.stringify({ sort, value, id: row.id }))
}

export function occurrenceCursor(value: string | undefined): OperatorOccurrenceCursor | undefined {
	if (value === undefined || value === '') return undefined
	const parsed = occurrenceCursorSchema.safeParse(decodedCursor(value))
	if (!parsed.success) throw badRequest('invalid cursor')
	return parsed.data
}

export function encodeOccurrenceCursor(row: OperatorOccurrenceRow): string {
	return encodeURIComponent(JSON.stringify({ receivedAt: numeric(row.received_at), id: row.id }))
}

function decodedCursor(value: string): unknown {
	let parsed: unknown
	try {
		parsed = JSON.parse(decodeURIComponent(value))
	} catch {
		throw badRequest('invalid cursor')
	}
	return parsed
}
