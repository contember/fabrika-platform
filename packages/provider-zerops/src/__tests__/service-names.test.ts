import { describe, expect, test } from 'bun:test'
import { zeropsSharedServiceHostname, zeropsSharedServicePrefix } from '../service-names'

describe('Zerops shared service names', () => {
	test('keeps short canonical app ids readable', () => {
		expect(zeropsSharedServicePrefix('notes')).toBe('notes')
		expect(zeropsSharedServiceHostname('notes', 'api')).toBe('notesapi')
		expect(zeropsSharedServiceHostname('notes', 'db')).toBe('notesdb')
	})

	test('hashes normalized or long ids deterministically without exceeding the prefix budget', () => {
		const first = zeropsSharedServicePrefix('Team/Very-Long Notes')
		const again = zeropsSharedServicePrefix('Team/Very-Long Notes')
		const distinct = zeropsSharedServicePrefix('Team Very Long Notes')

		expect(first).toBe(again)
		expect(first).not.toBe(distinct)
		expect(first).toMatch(/^[a-z0-9]{1,12}$/)
		expect(zeropsSharedServiceHostname('Team/Very-Long Notes', 'runtime')).toMatch(/^[a-z0-9]{1,25}$/)
	})

	test('rejects illegal local names and hostnames over the Zerops limit', () => {
		expect(() => zeropsSharedServiceHostname('notes', 'web-api')).toThrow('lowercase')
		expect(() => zeropsSharedServiceHostname('notes', 'averyveryveryverylongservice')).toThrow('25-character')
		expect(() => zeropsSharedServicePrefix('---')).toThrow('letter or number')
	})
})
