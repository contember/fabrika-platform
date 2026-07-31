import { D1Database, Worker } from '@fabrika/provider-cloudflare'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import config, { buildPropustkaWorker } from './fabrika.config'
import oblakaDefinition from './oblaka'

const REMOTE_SOURCE: Record<string, string> = {
	FABRIKA_IAM_HUMAN_EMAIL_DOMAINS: '["example.com"]',
	FABRIKA_IAM_OIDC_ISSUER: 'https://oidc.example.com',
	FABRIKA_IAM_OIDC_CLIENT_ID: 'client-id',
	FABRIKA_IAM_SIGNING_KEYS: 'private-signing-key-material',
	OIDC_CLIENT_SECRET: 'private-oidc-secret',
}
const REMOTE_DOMAIN = 'iam.example.com'
const ENV_NAMES = [
	...Object.keys(REMOTE_SOURCE),
	'FABRIKA_IAM_HOSTNAME',
	'PROPUSTKA_HOSTNAME',
	'PROPUSTKA_HUMAN_EMAIL_DOMAINS',
	'PROPUSTKA_OIDC_ISSUER',
	'PROPUSTKA_OIDC_CLIENT_ID',
	'PROPUSTKA_OIDC_REQUIRE_VERIFIED_EMAIL',
	'PROPUSTKA_SIGNING_KEYS',
]
const originalEnvironment = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))

beforeEach(() => {
	for (const name of ENV_NAMES) {
		delete process.env[name]
	}
	for (const [name, value] of Object.entries(REMOTE_SOURCE)) {
		process.env[name] = value
	}
	process.env['FABRIKA_IAM_HOSTNAME'] = REMOTE_DOMAIN
})

afterAll(() => {
	for (const [name, value] of originalEnvironment) {
		if (value === undefined) {
			delete process.env[name]
		} else {
			process.env[name] = value
		}
	}
})

const requireWorker = (worker: Worker | undefined): Worker => {
	if (worker === undefined) {
		throw new Error('Oblaka definition did not materialize a Worker')
	}
	return worker
}

describe('IAM resource graph', () => {
	test('declares only canonical IAM pipeline inputs', () => {
		expect(config.pipeline?.vars).toEqual([
			'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS',
			'FABRIKA_IAM_OIDC_ISSUER',
			'FABRIKA_IAM_OIDC_CLIENT_ID',
		])
		expect(config.pipeline?.secrets).toEqual([
			'FABRIKA_IAM_SIGNING_KEYS',
			'OIDC_CLIENT_SECRET',
			'FABRIKA_IAM_PROVISIONING_KEY',
		])
	})

	test('local fabrika and Oblaka entries materialize the same Worker', () => {
		const fromFabrika = config.resources({ env: 'local' })
		const fromOblaka = requireWorker(oblakaDefinition({ env: 'local' }))

		expect(fromOblaka.options).toEqual(fromFabrika.options)
		expect(fromFabrika.options.routes).toEqual([])
		expect(fromFabrika.options.vars?.['ISSUER']).toBe('http://localhost:18191')
	})

	test('remote fabrika and Oblaka entries materialize the same routed Worker', () => {
		const fromFabrika = config.resources({ env: 'stage', domain: REMOTE_DOMAIN })
		const fromOblaka = requireWorker(oblakaDefinition({ env: 'stage' }))

		expect(fromOblaka.options).toEqual(fromFabrika.options)
		expect(fromFabrika.options.routes).toEqual([{ pattern: REMOTE_DOMAIN, custom_domain: true }])
		expect(fromFabrika.options.vars?.['ISSUER']).toBe(`https://${REMOTE_DOMAIN}`)
		expect(fromFabrika.options.bindings?.['DB']).toBeInstanceOf(D1Database)
	})

	test('remote materialization rejects every required non-secret, secret, and hostname input', () => {
		for (const name of Object.keys(REMOTE_SOURCE)) {
			const source = { ...REMOTE_SOURCE }
			delete source[name]
			expect(() => buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, source)).toThrow(name)
		}

		expect(() => buildPropustkaWorker({ env: 'stage' }, REMOTE_SOURCE)).toThrow('FABRIKA_IAM_HOSTNAME')
	})

	test('legacy deploy inputs remain canonical-first fallbacks', () => {
		const legacySource = {
			PROPUSTKA_HUMAN_EMAIL_DOMAINS: '["legacy.example"]',
			PROPUSTKA_OIDC_ISSUER: 'https://legacy-oidc.example.com',
			PROPUSTKA_OIDC_CLIENT_ID: 'legacy-client-id',
			PROPUSTKA_OIDC_REQUIRE_VERIFIED_EMAIL: 'false',
			PROPUSTKA_SIGNING_KEYS: 'legacy-private-key-material',
			OIDC_CLIENT_SECRET: 'private-oidc-secret',
		}
		const worker = buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, legacySource)

		expect(worker.options.vars?.['HUMAN_EMAIL_DOMAINS']).toBe('["legacy.example"]')
		expect(worker.options.vars?.['OIDC_ISSUER']).toBe('https://legacy-oidc.example.com')
		expect(worker.options.vars?.['OIDC_CLIENT_ID']).toBe('legacy-client-id')
		expect(worker.options.vars?.['OIDC_REQUIRE_VERIFIED_EMAIL']).toBe('false')
	})

	test('canonical deploy inputs win when both names are present', () => {
		const worker = buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, {
			...REMOTE_SOURCE,
			PROPUSTKA_HUMAN_EMAIL_DOMAINS: '["legacy.example"]',
			PROPUSTKA_OIDC_ISSUER: 'https://legacy-oidc.example.com',
			PROPUSTKA_OIDC_CLIENT_ID: 'legacy-client-id',
			FABRIKA_IAM_OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
			PROPUSTKA_OIDC_REQUIRE_VERIFIED_EMAIL: 'false',
			PROPUSTKA_SIGNING_KEYS: 'legacy-private-key-material',
		})

		expect(worker.options.vars?.['HUMAN_EMAIL_DOMAINS']).toBe('["example.com"]')
		expect(worker.options.vars?.['OIDC_ISSUER']).toBe('https://oidc.example.com')
		expect(worker.options.vars?.['OIDC_CLIENT_ID']).toBe('client-id')
		expect(worker.options.vars?.['OIDC_REQUIRE_VERIFIED_EMAIL']).toBe('true')
	})

	test('remote secrets are required but never enter plaintext Worker vars', () => {
		const worker = buildPropustkaWorker({ env: 'prod', domain: REMOTE_DOMAIN }, REMOTE_SOURCE)
		const serializedOptions = JSON.stringify(worker.options)

		expect(worker.options.vars?.['FABRIKA_IAM_SIGNING_KEYS']).toBeUndefined()
		expect(worker.options.vars?.['OIDC_CLIENT_SECRET']).toBeUndefined()
		expect(serializedOptions).not.toContain(REMOTE_SOURCE['FABRIKA_IAM_SIGNING_KEYS'])
		expect(serializedOptions).not.toContain(REMOTE_SOURCE['OIDC_CLIENT_SECRET'])
	})

	test('unknown environments fail through both entry paths', () => {
		expect(() => config.resources({ env: 'preview', domain: REMOTE_DOMAIN })).toThrow('Unknown environment preview')
		expect(() => oblakaDefinition({ env: 'preview' })).toThrow('Unknown environment preview')
	})
})
