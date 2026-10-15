import { describe, expect, test } from 'bun:test'
import { FABRIKA_IAM_APP_ID } from '../app-environment'
import { FABRIKA_IAM_ISSUER } from '../environment'
import {
	connectVariables,
	FRAMEWORK_VARIABLE_NAMES,
	frameworkVariableReference,
	isConnectKeyVariable,
	isConnectUrlVariable,
	isEmailTransportVariable,
	isFrameworkVariableName,
	isWorkloadKeyVariable,
	workloadKeyVariable,
} from '../framework-variables'

describe('framework-only variable names', () => {
	test('include the names auth-core itself defines', () => {
		expect(isFrameworkVariableName(FABRIKA_IAM_APP_ID)).toBe(true)
		expect(isFrameworkVariableName(FABRIKA_IAM_ISSUER)).toBe(true)
	})

	test('reserve the database credential and the contract digest', () => {
		expect(isFrameworkVariableName('FABRIKA_APP_DATABASE_URL')).toBe(true)
		expect(isFrameworkVariableName('FABRIKA_CONTRACT_DIGEST')).toBe(true)
	})

	test('reserve the source-map upload of a platform build', () => {
		expect(isFrameworkVariableName('FABRIKA_SOURCE_MAP_UPLOAD')).toBe(true)
		expect(isFrameworkVariableName('FABRIKA_SOURCE_MAP_UPLOAD_KEY')).toBe(true)
		expect(frameworkVariableReference('${RUNTIME_FABRIKA_SOURCE_MAP_UPLOAD_KEY}')).not.toBeNull()
	})

	test('leave application names and public build values to the application', () => {
		for (const name of ['NOTES_DATABASE_URL', 'FABRIKA_PUBLIC_API_ORIGIN', 'fabrika_release', 'FABRIKA_RELEASE ']) {
			expect(isFrameworkVariableName(name)).toBe(false)
		}
	})

	test('reserve every name of a workload family', () => {
		for (const name of ['FABRIKA_JOB_NIGHTLY_KEY', 'FABRIKA_WEBHOOK_GITHUB_KEY', 'FABRIKA_JOB_ANYTHING', 'FABRIKA_CONNECT_CATALOG_KEY']) {
			expect(isFrameworkVariableName(name)).toBe(true)
		}
		for (const name of ['FABRIKA_JOB_', 'FABRIKA_JOBS', 'FABRIKA_CONNECT_', 'FABRIKA_CONNECTOR']) {
			expect(isFrameworkVariableName(name)).toBe(false)
		}
		expect(frameworkVariableReference('${RUNTIME_FABRIKA_JOB_NIGHTLY_KEY}')).not.toBeNull()
	})

	test('name a workload key after its kind and its name', () => {
		expect(workloadKeyVariable('job', 'nightlyDigest')).toBe('FABRIKA_JOB_NIGHTLY_DIGEST_KEY')
		expect(workloadKeyVariable('webhook', 'github')).toBe('FABRIKA_WEBHOOK_GITHUB_KEY')
		expect(isWorkloadKeyVariable(workloadKeyVariable('job', 'nightlyDigest'))).toBe(true)
		for (const name of ['FABRIKA_JOB__KEY', 'FABRIKA_CONNECT_CATALOG_KEY', 'FABRIKA_JOB_NIGHTLY', 'FABRIKA_PROXY_SECRET']) {
			expect(isWorkloadKeyVariable(name)).toBe(false)
		}
	})

	test("name a connector import's variables and binding after the import", () => {
		expect(connectVariables('productCatalog')).toEqual({
			url: 'FABRIKA_CONNECT_PRODUCT_CATALOG_URL',
			key: 'FABRIKA_CONNECT_PRODUCT_CATALOG_KEY',
			binding: 'FABRIKA_CONNECT_PRODUCT_CATALOG',
		})
		for (const name of Object.values(connectVariables('catalog'))) {
			expect(isFrameworkVariableName(name)).toBe(true)
			expect(isWorkloadKeyVariable(name)).toBe(false)
		}
		const { url, key, binding } = connectVariables('catalog')
		expect([isConnectKeyVariable(key), isConnectUrlVariable(url)]).toEqual([true, true])
		expect([isConnectKeyVariable(url), isConnectUrlVariable(key), isConnectKeyVariable(binding), isConnectUrlVariable(binding)]).toEqual([
			false,
			false,
			false,
			false,
		])
	})

	test("reserve the installation's mail transport", () => {
		expect(isFrameworkVariableName('FABRIKA_EMAIL_RESEND_API_KEY')).toBe(true)
		expect(frameworkVariableReference('${RUNTIME_FABRIKA_EMAIL_FROM}')).not.toBeNull()
		for (const name of ['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_SMARTEMAILING_API_KEY']) {
			expect(isEmailTransportVariable(name)).toBe(true)
		}
		for (const name of ['FABRIKA_EMAIL_', 'FABRIKA_EMAIL_from', 'FABRIKA_EMAILS', 'FABRIKA_JOB_NIGHTLY_KEY']) {
			expect(isEmailTransportVariable(name)).toBe(false)
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
