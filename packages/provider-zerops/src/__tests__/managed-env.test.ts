// The platform transport family on a Zerops service: the receiver's address is a plain origin, private `http` included,
// its key is a sensitive px_ key, and a stale one is removed with the other families.

import { describe, expect, test } from 'bun:test'
import { isFrameworkFamilyVariable, isSensitiveFamilyVariable, type ManagedValues, parseManagedEnvironment } from '../managed-env'

const MANAGED: ManagedValues = {
	FABRIKA_RELEASE: null,
	FABRIKA_OPERATIONS_DSN: null,
	FABRIKA_IAM_ISSUER: null,
	FABRIKA_IAM_APP_ID: 'notes@prod',
	FABRIKA_APP_ID: null,
	FABRIKA_ENVIRONMENT: null,
	FABRIKA_SERVICE_KEY: null,
	FABRIKA_PROXY_SECRET: null,
	FABRIKA_IAM_RPC_URL: null,
	FABRIKA_IAM_RPC_KEY: null,
	FABRIKA_APP_ORIGIN: null,
	FABRIKA_TOKEN_KEYS: null,
}

const KEY = `px_${'k'.repeat(27)}`

describe('the platform transport family', () => {
	test("hands the relay's public origin and the key beside the managed values; the local stack's is http", () => {
		const parsed = parseManagedEnvironment({
			...MANAGED,
			FABRIKA_EMAIL_PROVIDER: 'platform',
			FABRIKA_PLATFORM_MAIL_URL: 'https://control.example.com',
			FABRIKA_PLATFORM_MAIL_KEY: KEY,
		})
		expect(parsed.values).toEqual(MANAGED)
		expect(parsed.familyVariables).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'platform',
			FABRIKA_PLATFORM_MAIL_URL: 'https://control.example.com',
			FABRIKA_PLATFORM_MAIL_KEY: KEY,
		})
		const local = 'http://control.fabrika.localhost:18080'
		expect(parseManagedEnvironment({ ...MANAGED, FABRIKA_PLATFORM_MAIL_URL: local }).familyVariables).toEqual({
			FABRIKA_PLATFORM_MAIL_URL: local,
		})
	})

	test('refuses an address that is not an http(s) origin, a key that is not a px_ key, and a name no deploy writes', () => {
		for (const url of ['http://control:3000/', 'http://control:3000/platform', 'ftp://control:3000', 'control:3000', '']) {
			expect(() => parseManagedEnvironment({ ...MANAGED, FABRIKA_PLATFORM_MAIL_URL: url })).toThrow(
				'zerops: FABRIKA_PLATFORM_MAIL_URL must be an http(s) origin',
			)
		}
		expect(() => parseManagedEnvironment({ ...MANAGED, FABRIKA_PLATFORM_MAIL_KEY: 'private-plain' })).toThrow(
			'zerops: FABRIKA_PLATFORM_MAIL_KEY must be a px_ key',
		)
		expect(() => parseManagedEnvironment({ ...MANAGED, FABRIKA_PLATFORM_MAIL_KEY: null })).toThrow('FABRIKA_PLATFORM_MAIL_KEY must be a px_ key')
		expect(() => parseManagedEnvironment({ ...MANAGED, FABRIKA_PLATFORM_AUDIT_KEY: KEY })).toThrow(
			'zerops: FABRIKA_PLATFORM_AUDIT_KEY is not a variable a deploy writes',
		)
	})

	test('a connector origin still has to be https', () => {
		expect(() => parseManagedEnvironment({ ...MANAGED, FABRIKA_CONNECT_CATALOG_URL: 'http://catalog:3000' })).toThrow(
			'zerops: FABRIKA_CONNECT_CATALOG_URL must be an https origin',
		)
	})

	test('the key is written sensitive and the address plain; a stale one of either is a family variable a deploy removes', () => {
		expect(isSensitiveFamilyVariable('FABRIKA_PLATFORM_MAIL_KEY')).toBe(true)
		expect(isSensitiveFamilyVariable('FABRIKA_PLATFORM_MAIL_URL')).toBe(false)
		expect(isSensitiveFamilyVariable('FABRIKA_EMAIL_PROVIDER')).toBe(true)
		expect(isSensitiveFamilyVariable('FABRIKA_CONNECT_CATALOG_URL')).toBe(false)
		for (const name of ['FABRIKA_PLATFORM_MAIL_URL', 'FABRIKA_PLATFORM_MAIL_KEY', 'FABRIKA_PLATFORM_AUDIT_KEY']) {
			expect(isFrameworkFamilyVariable(name)).toBe(true)
		}
	})
})
