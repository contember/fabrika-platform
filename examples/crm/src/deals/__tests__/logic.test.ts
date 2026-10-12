import { expect, test } from 'bun:test'
import { DEAL_STAGES } from '../../schemas'
import { isClosed, safeTotal } from '../logic'

test('only a won or a lost deal is closed', () => {
	expect(DEAL_STAGES.filter(isClosed)).toEqual(['won', 'lost'])
})

test('a bigint sum is a number up to 2^53 - 1 and refused past it, never rounded', () => {
	expect(safeTotal('3000000000')).toBe(3_000_000_000)
	expect(safeTotal('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
	expect(() => safeTotal('9007199254740993')).toThrow('beyond the safe integer range')
})
