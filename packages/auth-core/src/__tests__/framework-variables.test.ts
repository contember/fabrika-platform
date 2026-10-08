import { describe, expect, test } from 'bun:test'
import { FABRIKA_IAM_APP_ID } from '../app-environment'
import { FABRIKA_IAM_ISSUER } from '../environment'
import { FRAMEWORK_VARIABLE_NAMES, frameworkVariableReference, isFrameworkVariableName } from '../framework-variables'

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

describe('frameworkVariableReference', () => {
	test('finds a framework-only name in every Zerops reference form', () => {
		for (
			const text of [
				'${FABRIKA_PROXY_SECRET}',
				'${RUNTIME_FABRIKA_PROXY_SECRET}',
				'${api_FABRIKA_PROXY_SECRET}',
				'${RUNTIME_api_FABRIKA_PROXY_SECRET}',
				'prefix-${FABRIKA_APP_DATABASE_URL}-suffix',
				'${FABRIKA_PROXY_SECRET',
			]
		) {
			expect(frameworkVariableReference(text)).not.toBeNull()
		}
	})

	test('refuses a nested reference, whose name only Zerops resolves', () => {
		expect(frameworkVariableReference('${FABRIKA_PROXY_${SUFFIX}}')).toBe('${FABRIKA_PROXY_${SUFFIX}')
		expect(frameworkVariableReference('${RUNTIME_${NAME}}')).not.toBeNull()
	})

	test('leaves application references, plain text and look-alikes alone', () => {
		for (const text of ['${db_connectionString}', '${RUNTIME_IMAGE}', '${FABRIKA_PUBLIC_API_ORIGIN}', 'FABRIKA_PROXY_SECRET', '$FABRIKA_RELEASE', '']) {
			expect(frameworkVariableReference(text)).toBeNull()
		}
	})
})
