// `resolveCaller` over the rows a read answers, without a database: what each answer of `rowsNaming` becomes. The
// faults a contract's types prevent (two rows, a refusal naming a column the row lacks) are reachable only here.

import { describe, expect, test } from 'bun:test'
import type { CallerDeclaration } from '../contract/caller'
import { resolveCaller } from '../implement/caller'
import type { Principal } from '../implement/principal'

const declaration: CallerDeclaration = {
	table: 'people',
	principal: 'principal_id',
	missing: 'No card.',
	refuse: [{ column: 'archived_at', not: null, message: 'Archived.' }],
}
const person: Principal = { kind: 'user', id: 'p-1', label: 'Ada', email: 'ada@example.com' }

const answering = (rows: readonly Readonly<Record<string, unknown>>[]) => {
	const asked: string[][] = []
	return {
		asked,
		handles: {
			rowsNaming: async (table: string, column: string, value: string) => {
				asked.push([table, column, value])
				return rows
			},
		},
	}
}

describe('resolveCaller', () => {
	test("reads the person's row by the declared column and answers a frozen copy", async () => {
		const row = { id: 'c-1', principal_id: 'p-1', archived_at: null }
		const { asked, handles } = answering([row])
		const caller = await resolveCaller(declaration, handles, person)
		expect(caller).toEqual(row)
		expect(caller).not.toBe(row)
		expect(Object.isFrozen(caller)).toBe(true)
		expect(asked).toEqual([['people', 'principal_id', 'p-1']])
	})

	test('no row is the 403 of missing, a refused row the 403 of its rule', async () => {
		await expect(resolveCaller(declaration, answering([]).handles, person)).rejects.toMatchObject({ httpStatus: 403, message: 'No card.' })
		const archived = answering([{ id: 'c-1', principal_id: 'p-1', archived_at: '2026-11-21' }])
		await expect(resolveCaller(declaration, archived.handles, person)).rejects.toMatchObject({ httpStatus: 403, message: 'Archived.' })
	})

	test('two rows are caller_ambiguous, never a pick of one', async () => {
		const rows = [{ id: 'c-1', archived_at: null }, { id: 'c-2', archived_at: null }]
		await expect(resolveCaller(declaration, answering(rows).handles, person)).rejects.toMatchObject({ reason: 'caller_ambiguous' })
	})

	test('a refusal naming a column the row lacks is caller_column, never a pass', async () => {
		const { handles } = answering([{ id: 'c-1', principal_id: 'p-1' }])
		await expect(resolveCaller(declaration, handles, person)).rejects.toMatchObject({ reason: 'caller_column' })
	})

	test('any principal but a person gets null and reads nothing', async () => {
		const { asked, handles } = answering([])
		expect(await resolveCaller(declaration, handles, { kind: 'service', id: 's-1', label: 'nightly' })).toBeNull()
		expect(asked).toEqual([])
	})
})
