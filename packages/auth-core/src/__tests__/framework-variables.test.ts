import { describe, expect, test } from 'bun:test'
import { FABRIKA_IAM_APP_ID } from '../app-environment'
import { FABRIKA_IAM_ISSUER } from '../environment'
import { FRAMEWORK_VARIABLE_NAMES, isFrameworkVariableName } from '../framework-variables'

describe('framework-only variable names', () => {
	test('include the names auth-core itself defines', () => {
		expect(isFrameworkVariableName(FABRIKA_IAM_APP_ID)).toBe(true)
		expect(isFrameworkVariableName(FABRIKA_IAM_ISSUER)).toBe(true)
	})

	test('reserve the database credential and the contract digest', () => {
		expect(isFrameworkVariableName('FABRIKA_APP_DATABASE_URL')).toBe(true)
		expect(isFrameworkVariableName('FABRIKA_CONTRACT_DIGEST')).toBe(true)
	})

	test('leave application names and public build values to the application', () => {
		for (const name of ['NOTES_DATABASE_URL', 'FABRIKA_PUBLIC_API_ORIGIN', 'fabrika_release', 'FABRIKA_RELEASE ']) {
			expect(isFrameworkVariableName(name)).toBe(false)
		}
	})

	test('list each name once', () => {
		expect(new Set(FRAMEWORK_VARIABLE_NAMES).size).toBe(FRAMEWORK_VARIABLE_NAMES.length)
	})
})
