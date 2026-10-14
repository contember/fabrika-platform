// What the screens show for an answer: stage labels and the next stage, money, days, and the form fields' values.

import { describe, expect, test } from 'bun:test'
import { dateTime, day, money, nextStage, orNull, orOmitted, stageOf, text, wholeNumber } from '../format'

describe('stages', () => {
	test('an open deal moves on one stage and never to lost; a closed one does not move on', () => {
		expect(nextStage('lead')).toBe('qualified')
		expect(nextStage('qualified')).toBe('proposal')
		expect(nextStage('proposal')).toBe('won')
		expect(nextStage('won')).toBeNull()
		expect(nextStage('lost')).toBeNull()
	})

	test('a stage is read from a select only when it is one', () => {
		expect(stageOf('proposal')).toBe('proposal')
		expect(stageOf('Proposal')).toBeNull()
		expect(stageOf('')).toBeNull()
	})
})

describe('values', () => {
	test('money is whole euros, days and times are UTC', () => {
		expect(money(4200)).toBe('€4,200')
		expect(day('2026-10-14')).toBe('14 Oct 2026')
		expect(dateTime('2026-10-14T09:30:00.000Z')).toBe('14 Oct 2026, 09:30')
		expect(day('not a day')).toBe('not a day')
	})

	test('a value field holds a whole number or NaN, which the input schema refuses with its own message', () => {
		expect(wholeNumber('900')).toBe(900)
		expect(Number.isNaN(wholeNumber('9.5'))).toBe(true)
		expect(Number.isNaN(wholeNumber(''))).toBe(true)
	})

	test('an empty field is left out of a create and clears a column on an edit', () => {
		const form = new FormData()
		form.set('title', '  Toner  ')
		form.set('source', '')
		expect(text(form, 'title')).toBe('Toner')
		expect(text(form, 'missing')).toBe('')
		expect(orOmitted(text(form, 'source'))).toBeUndefined()
		expect(orNull(text(form, 'source'))).toBeNull()
		expect(orNull('referral')).toBe('referral')
	})
})
