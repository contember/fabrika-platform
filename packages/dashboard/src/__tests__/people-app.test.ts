import { describe, expect, test } from 'bun:test'
import { selectedPeopleApp } from '../routes/people/index'

const apps = [{ app: 'notes@prod' }, { app: 'notes@test' }]

describe('the application a people page shows', () => {
	test('the one asked for, else the first', () => {
		expect(selectedPeopleApp(apps, 'notes@test')).toEqual({ app: 'notes@test' })
		expect(selectedPeopleApp(apps, undefined)).toEqual({ app: 'notes@prod' })
	})

	test('one the caller does not administer is not swapped for another', () => {
		expect(selectedPeopleApp(apps, 'notes@staging')).toBeNull()
		expect(selectedPeopleApp([], undefined)).toBeNull()
	})
})
