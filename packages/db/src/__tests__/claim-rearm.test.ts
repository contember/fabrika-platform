// When a claim re-arms its job (ADR-0065 §5), under a fixed clock: the claim measures by the database's clock, which no
// test holds still, so the end-to-end suites keep their rows minutes apart and the sub-second cases live here.

import { describe, expect, test } from 'bun:test'
import { claimRearmAt } from '../orm'

const NOW = new Date('2026-11-04T12:00:00.000Z')
const at = (ms: number): Date => new Date(NOW.getTime() + ms)

describe('claimRearmAt', () => {
	test('a claim that took its full limit re-arms at once, whatever row is due next', () => {
		expect(claimRearmAt(NOW, true, null)).toEqual(at(1))
		expect(claimRearmAt(NOW, true, at(60_000))).toEqual(at(1))
	})

	test('a claim re-arms at the next due row it would take', () => {
		expect(claimRearmAt(NOW, false, at(120_000))).toEqual(at(120_000))
		expect(claimRearmAt(NOW, false, at(1_000))).toEqual(at(1_000))
	})

	test('never sooner than a second after the claim, though a row comes due sooner', () => {
		expect(claimRearmAt(NOW, false, at(100))).toEqual(at(1_000))
		expect(claimRearmAt(NOW, false, at(999))).toEqual(at(1_000))
		expect(claimRearmAt(NOW, false, at(1))).toEqual(at(1_000))
	})

	test('a claim that would take no further row re-arms nothing', () => {
		expect(claimRearmAt(NOW, false, null)).toBeNull()
	})
})
