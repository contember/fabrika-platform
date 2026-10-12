// `fromRow`: a row as an output object — columns to fields, dates to ISO text, undeclared columns dropped, and the
// schema checking what the row only types as text. `fromPage`: a list's page, each row through `fromRow`.

import { fromPage, fromRow } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

const Deal = z.strictObject({
	id: z.string(),
	companyId: z.string(),
	stage: z.enum(['lead', 'won']),
	closedAt: z.nullable(z.iso.datetime()),
	margin: z.optional(z.number()),
})

describe('fromRow', () => {
	test('snake_case columns become camelCase fields, a Date its ISO text, and an undeclared column is dropped', () => {
		const row = { id: 'd1', company_id: 'c1', stage: 'won', closed_at: new Date('2026-10-11T12:00:00Z'), created_by: 'user-1' }
		expect(fromRow(Deal, row)).toEqual({ id: 'd1', companyId: 'c1', stage: 'won', closedAt: '2026-10-11T12:00:00.000Z' })
	})

	test('a day stays a day: YYYY-MM-DD text passes through, and a Date for a z.iso.date() field becomes its day', () => {
		const Task = z.strictObject({ dueOn: z.iso.date(), startOn: z.iso.date().nullable(), closedAt: z.iso.datetime() })
		const row = { due_on: '2026-10-20', start_on: new Date('2026-10-19T00:00:00Z'), closed_at: new Date('2026-10-21T08:00:00Z') }
		expect(fromRow(Task, row)).toEqual({ dueOn: '2026-10-20', startOn: '2026-10-19', closedAt: '2026-10-21T08:00:00.000Z' })
	})

	test('a literal-string field typed as text by the row is checked by the schema', () => {
		const row: { id: string; company_id: string; stage: string; closed_at: null } = { id: 'd1', company_id: 'c1', stage: 'open', closed_at: null }
		expect(() => fromRow(Deal, row)).toThrow()
	})
})

describe('fromPage', () => {
	test('maps every row of a page and keeps its cursor', () => {
		const page = {
			items: [
				{ id: 'd1', company_id: 'c1', stage: 'lead', closed_at: null, version: 1 },
				{ id: 'd2', company_id: 'c1', stage: 'won', closed_at: new Date('2026-10-11T12:00:00Z'), version: 3 },
			],
			next: 'cursor-2',
		}
		expect(fromPage(Deal, page)).toEqual({
			items: [
				{ id: 'd1', companyId: 'c1', stage: 'lead', closedAt: null },
				{ id: 'd2', companyId: 'c1', stage: 'won', closedAt: '2026-10-11T12:00:00.000Z' },
			],
			next: 'cursor-2',
		})
		expect(fromPage(Deal, { items: [], next: null })).toEqual({ items: [], next: null })
	})

	test('a row the schema refuses fails the whole page', () => {
		const page = { items: [{ id: 'd1', company_id: 'c1', stage: 'open', closed_at: null }], next: null }
		expect(() => fromPage(Deal, page)).toThrow()
	})
})
