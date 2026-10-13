import { expect, test } from 'bun:test'
import { DEAL_STAGES } from '../../schemas'
import { exactInteger, isClosed, pipelineOf } from '../logic'

test('only a won or a lost deal is closed', () => {
	expect(DEAL_STAGES.filter(isClosed)).toEqual(['won', 'lost'])
})

test('a bigint sum is a number up to 2^53 - 1 and refused past it, never rounded', () => {
	expect(exactInteger('3000000000')).toBe(3_000_000_000)
	expect(exactInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
	expect(() => exactInteger('9007199254740993')).toThrow('beyond the safe integer range')
})

test('the pipeline holds every stage in pipeline order, a stage without deals as 0 of 0', () => {
	expect(pipelineOf([{ stage: 'won', count: '2', sum_value: '3000000000' }, { stage: 'lead', count: '1', sum_value: '250' }])).toEqual([
		{ stage: 'lead', count: 1, value: 250 },
		{ stage: 'qualified', count: 0, value: 0 },
		{ stage: 'proposal', count: 0, value: 0 },
		{ stage: 'won', count: 2, value: 3_000_000_000 },
		{ stage: 'lost', count: 0, value: 0 },
	])
})
