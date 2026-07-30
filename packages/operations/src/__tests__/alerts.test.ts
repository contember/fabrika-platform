import { describe, expect, test } from 'bun:test'
import { evaluateSpike } from '../alerts.js'

describe('alert semantics', () => {
	test('fires exactly at the threshold', () => {
		expect(evaluateSpike({ count: 9, threshold: 10, claimed: false })).toEqual({ fire: false, deduped: false })
		expect(evaluateSpike({ count: 10, threshold: 10, claimed: false })).toEqual({ fire: true, deduped: false })
	})

	test('reports an already claimed spike as deduplicated', () => {
		expect(evaluateSpike({ count: 11, threshold: 10, claimed: true })).toEqual({ fire: false, deduped: true })
	})
})
