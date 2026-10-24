import { describe, expect, test } from 'bun:test'
import {
	isManagedCredential,
	MANAGED_VARIABLE_NAMES,
	managedValue,
	parseManagedEnvironment,
	staleManagedVariables,
	workloadKeyVariable,
} from '../index'

const KEY = `px_${'k'.repeat(27)}`
const NONE: Readonly<Record<string, null>> = Object.fromEntries(MANAGED_VARIABLE_NAMES.map((name) => [name, null]))

describe('the credential rule', () => {
	test('identities, origins and the release are plain; every key, the DSN and the mail transport are credentials', () => {
		for (const name of ['FABRIKA_RELEASE', 'FABRIKA_IAM_ISSUER', 'FABRIKA_IAM_APP_ID', 'FABRIKA_APP_ID', 'FABRIKA_ENVIRONMENT']) {
			expect(isManagedCredential(name)).toBe(false)
		}
		for (
			const name of ['FABRIKA_IAM_RPC_URL', 'FABRIKA_APP_ORIGIN', 'FABRIKA_CONTRACT_DIGEST', 'FABRIKA_CONNECT_CATALOG_URL', 'FABRIKA_PLATFORM_MAIL_URL']
		) {
			expect(isManagedCredential(name)).toBe(false)
		}
		for (
			const name of [
				'FABRIKA_OPERATIONS_DSN',
				'FABRIKA_SERVICE_KEY',
				'FABRIKA_PROXY_SECRET',
				'FABRIKA_IAM_RPC_KEY',
				'FABRIKA_TOKEN_KEYS',
				workloadKeyVariable('job', 'nightly'),
				'FABRIKA_CONNECT_CATALOG_KEY',
				'FABRIKA_PLATFORM_MAIL_KEY',
				'FABRIKA_EMAIL_PROVIDER',
				'FABRIKA_EMAIL_FROM',
			]
		) {
			expect(isManagedCredential(name)).toBe(true)
		}
	})

	test('fails closed: a name not known to be public is a credential', () => {
		expect(isManagedCredential('FABRIKA_SOURCE_MAP_UPLOAD_KEY')).toBe(true)
		expect(isManagedCredential('FABRIKA_SOMETHING_NEW')).toBe(true)
	})

	test('the parsed entries carry it', () => {
		const parsed = parseManagedEnvironment({ ...NONE, FABRIKA_IAM_APP_ID: 'notes@prod', FABRIKA_PROXY_SECRET: 'secret' })
		expect(parsed['FABRIKA_IAM_APP_ID']).toEqual({ value: 'notes@prod', credential: false })
		expect(parsed['FABRIKA_PROXY_SECRET']).toEqual({ value: 'secret', credential: true })
		expect(parsed['FABRIKA_RELEASE']).toEqual({ value: null, credential: false })
		expect(managedValue(parsed, 'FABRIKA_IAM_APP_ID')).toBe('notes@prod')
		expect(managedValue(parsed, 'FABRIKA_RELEASE')).toBeNull()
		expect(managedValue(parsed, 'FABRIKA_CONNECT_CATALOG_URL')).toBeNull()
	})
})

describe('parsing what Control hands a deploy', () => {
	test('admits the managed names and the families with their shapes', () => {
		const handed = {
			...NONE,
			[workloadKeyVariable('job', 'nightly')]: KEY,
			[workloadKeyVariable('public', 'api.stats.cta')]: KEY,
			FABRIKA_CONNECT_CATALOG_KEY: KEY,
			FABRIKA_CONNECT_CATALOG_URL: 'https://catalog.example.com',
			FABRIKA_EMAIL_PROVIDER: 'platform',
			FABRIKA_PLATFORM_MAIL_URL: 'https://control.example.com',
			FABRIKA_PLATFORM_MAIL_KEY: KEY,
		}
		expect(Object.keys(parseManagedEnvironment(handed)).sort()).toEqual(Object.keys(handed).sort())
		// Control's public origin is http in the local stack.
		expect(managedValue(parseManagedEnvironment({ FABRIKA_PLATFORM_MAIL_URL: 'http://control.fabrika.localhost:18080' }), 'FABRIKA_PLATFORM_MAIL_URL'))
			.toBe('http://control.fabrika.localhost:18080')
	})

	test('refuses a platform receiver address that is not an http(s) origin, and a key that is not a px_ key', () => {
		for (const url of ['http://control:3000/', 'http://control:3000/platform', 'ftp://control:3000', 'control:3000', '']) {
			expect(() => parseManagedEnvironment({ FABRIKA_PLATFORM_MAIL_URL: url })).toThrow(
				'managed environment: FABRIKA_PLATFORM_MAIL_URL must be an http(s) origin',
			)
		}
		for (const name of ['FABRIKA_PLATFORM_MAIL_KEY', workloadKeyVariable('job', 'nightly'), 'FABRIKA_CONNECT_CATALOG_KEY']) {
			expect(() => parseManagedEnvironment({ [name]: 'private-plain' })).toThrow(`managed environment: ${name} must be a px_ key`)
			expect(() => parseManagedEnvironment({ [name]: null })).toThrow(`${name} must be a px_ key`)
		}
	})

	test('a connector origin has to be https, and a mail variable must not be empty', () => {
		expect(() => parseManagedEnvironment({ FABRIKA_CONNECT_CATALOG_URL: 'http://catalog.example.com' })).toThrow(
			'FABRIKA_CONNECT_CATALOG_URL must be an https origin',
		)
		expect(() => parseManagedEnvironment({ FABRIKA_EMAIL_FROM: '' })).toThrow('managed environment: FABRIKA_EMAIL_FROM must not be empty')
	})

	test('refuses a name Control does not write: a family name outside its shapes, a framework name a provider writes, any other name', () => {
		for (const name of ['FABRIKA_PLATFORM_AUDIT_KEY', 'FABRIKA_CONNECT_CATALOG', 'FABRIKA_CONTRACT_DIGEST', 'FABRIKA_APP_DATABASE_URL', 'API_KEY']) {
			expect(() => parseManagedEnvironment({ [name]: KEY })).toThrow(`managed environment: ${name} is not a variable a deploy writes`)
		}
	})

	test('a refusal names the variable, never its value', () => {
		let message = ''
		try {
			parseManagedEnvironment({ FABRIKA_CONNECT_CATALOG_KEY: 'private-value' })
		} catch (error) {
			message = error instanceof Error ? error.message : ''
		}
		expect(message).toContain('FABRIKA_CONNECT_CATALOG_KEY')
		expect(message).not.toContain('private-value')
	})
})

describe('the variables a deploy no longer hands', () => {
	test('names a managed variable not written and a family member no longer handed; keeps what Control never writes', () => {
		const present = [
			'FABRIKA_TOKEN_KEYS',
			'FABRIKA_IAM_APP_ID',
			'FABRIKA_JOB_RETIRED_KEY',
			'FABRIKA_EMAIL_RESEND_API_KEY',
			'FABRIKA_STORAGE_PROVENANCE',
			'FABRIKA_SOURCE_MAP_UPLOAD_KEY',
			// A bare family prefix names no member.
			'FABRIKA_EMAIL_',
			'API_KEY',
		]
		expect(staleManagedVariables(present, new Set(['FABRIKA_IAM_APP_ID']))).toEqual([
			'FABRIKA_TOKEN_KEYS',
			'FABRIKA_JOB_RETIRED_KEY',
			'FABRIKA_EMAIL_RESEND_API_KEY',
		])
	})
})
