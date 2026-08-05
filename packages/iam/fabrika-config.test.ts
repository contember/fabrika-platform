import { D1Database, Worker } from '@fabrika/provider-cloudflare'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import config, { buildPropustkaWorker, iamPipelineSecrets, iamPipelineVars } from './fabrika.config'
import oblakaDefinition from './oblaka'

const REMOTE_SOURCE: Record<string, string> = {
	FABRIKA_IAM_OIDC_ENABLED: 'true',
	FABRIKA_IAM_PASSWORD_ENABLED: 'false',
	FABRIKA_IAM_HUMAN_EMAIL_DOMAINS: '["example.com"]',
	FABRIKA_IAM_OIDC_ISSUER: 'https://oidc.example.com',
	FABRIKA_IAM_OIDC_CLIENT_ID: 'client-id',
	FABRIKA_IAM_SIGNING_KEYS: 'private-signing-key-material',
	FABRIKA_EMAIL_PROVIDER: 'none',
	OIDC_CLIENT_SECRET: 'private-oidc-secret',
}
const REMOTE_DOMAIN = 'iam.example.com'
const ENV_NAMES = [
	...Object.keys(REMOTE_SOURCE),
	'FABRIKA_IAM_HOSTNAME',
	'FABRIKA_IAM_OIDC_REQUIRE_VERIFIED_EMAIL',
	'FABRIKA_EMAIL_FROM',
	'FABRIKA_EMAIL_RESEND_API_KEY',
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
		expect(iamPipelineVars(REMOTE_SOURCE)).toEqual([
			'FABRIKA_IAM_ADMIN_ORIGINS',
			'FABRIKA_IAM_OIDC_ENABLED',
			'FABRIKA_IAM_PASSWORD_ENABLED',
			'FABRIKA_EMAIL_PROVIDER',
			'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS',
			'FABRIKA_IAM_OIDC_ISSUER',
			'FABRIKA_IAM_OIDC_CLIENT_ID',
		])
		expect(iamPipelineSecrets(REMOTE_SOURCE)).toEqual([
			'FABRIKA_IAM_SIGNING_KEYS',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'OIDC_CLIENT_SECRET',
		])
	})

	test('local fabrika and Oblaka entries materialize the same Worker', () => {
		const fromFabrika = config.resources({ env: 'local' })
		const fromOblaka = requireWorker(oblakaDefinition({ env: 'local' }))

		expect(fromOblaka.options).toEqual(fromFabrika.options)
		expect(fromFabrika.options.routes).toEqual([])
		expect(fromFabrika.options.vars?.['ISSUER']).toBe('http://localhost:18191')
		// Local is PASSWORD-ONLY: OIDC is fatal when half-configured on both engines now, and a
		// `wrangler dev` has no client id or secret to hand it.
		expect(fromFabrika.options.vars?.['OIDC_ENABLED']).toBe('false')
		expect(fromFabrika.options.vars?.['PASSWORD_ENABLED']).toBe('true')
		expect(fromFabrika.options.vars?.['EMAIL_PROVIDER']).toBe('none')
	})

	test('remote fabrika and Oblaka entries materialize the same routed Worker', () => {
		const fromFabrika = config.resources({ env: 'stage', domain: REMOTE_DOMAIN })
		const fromOblaka = requireWorker(oblakaDefinition({ env: 'stage' }))

		expect(fromOblaka.options).toEqual(fromFabrika.options)
		expect(fromFabrika.options.routes).toEqual([{ pattern: REMOTE_DOMAIN, custom_domain: true }])
		expect(fromFabrika.options.vars?.['ISSUER']).toBe(`https://${REMOTE_DOMAIN}`)
		expect(fromFabrika.options.bindings?.['DB']).toBeInstanceOf(D1Database)
	})

	test('remote OIDC materialization rejects every required input', () => {
		for (
			const name of [
				'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS',
				'FABRIKA_IAM_OIDC_ISSUER',
				'FABRIKA_IAM_OIDC_CLIENT_ID',
				'FABRIKA_IAM_SIGNING_KEYS',
				'OIDC_CLIENT_SECRET',
			]
		) {
			const source = { ...REMOTE_SOURCE }
			delete source[name]
			expect(() => buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, source)).toThrow(name)
		}

		expect(() => buildPropustkaWorker({ env: 'stage' }, REMOTE_SOURCE)).toThrow('FABRIKA_IAM_HOSTNAME')
	})

	test('defaults missing authentication flags to OIDC-only', () => {
		const source = { ...REMOTE_SOURCE }
		delete source['FABRIKA_IAM_OIDC_ENABLED']
		delete source['FABRIKA_IAM_PASSWORD_ENABLED']
		const worker = buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, source)

		expect(worker.options.vars?.['OIDC_ENABLED']).toBe('true')
		expect(worker.options.vars?.['PASSWORD_ENABLED']).toBe('false')
	})

	test('supports password-only authentication without OIDC configuration', () => {
		const source = {
			FABRIKA_IAM_OIDC_ENABLED: 'false',
			FABRIKA_IAM_PASSWORD_ENABLED: 'true',
			FABRIKA_IAM_SIGNING_KEYS: 'private-signing-key-material',
			FABRIKA_EMAIL_PROVIDER: 'none',
		}
		const worker = buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, source)

		expect(worker.options.vars?.['OIDC_ENABLED']).toBe('false')
		expect(worker.options.vars?.['PASSWORD_ENABLED']).toBe('true')
		expect(worker.options.vars?.['OIDC_ISSUER']).toBe('')
		expect(iamPipelineVars(source)).toEqual([
			'FABRIKA_IAM_ADMIN_ORIGINS',
			'FABRIKA_IAM_OIDC_ENABLED',
			'FABRIKA_IAM_PASSWORD_ENABLED',
			'FABRIKA_EMAIL_PROVIDER',
		])
		expect(iamPipelineSecrets(source)).toEqual(['FABRIKA_IAM_SIGNING_KEYS', 'FABRIKA_IAM_PROVISIONING_KEY'])
	})

	test('rejects disabled or invalid authentication methods', () => {
		expect(() =>
			buildPropustkaWorker({ env: 'stage', domain: REMOTE_DOMAIN }, {
				...REMOTE_SOURCE,
				FABRIKA_IAM_OIDC_ENABLED: 'false',
				FABRIKA_IAM_PASSWORD_ENABLED: 'false',
			})
		).toThrow('At least one IAM authentication method must be enabled')
		expect(() => iamPipelineVars({ ...REMOTE_SOURCE, FABRIKA_IAM_PASSWORD_ENABLED: 'yes' })).toThrow(
			'FABRIKA_IAM_PASSWORD_ENABLED must be true or false',
		)
	})

	test('requires Resend configuration only when the provider is enabled', () => {
		const resend = {
			...REMOTE_SOURCE,
			FABRIKA_EMAIL_PROVIDER: 'resend',
			FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>',
			FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
		}
		const worker = buildPropustkaWorker({ env: 'prod', domain: REMOTE_DOMAIN }, resend)

		expect(worker.options.vars?.['EMAIL_PROVIDER']).toBe('resend')
		expect(worker.options.vars?.['EMAIL_FROM']).toBe('Fabrika <auth@example.com>')
		expect(iamPipelineVars(resend)).toContain('FABRIKA_EMAIL_FROM')
		expect(iamPipelineSecrets(resend)).toContain('FABRIKA_EMAIL_RESEND_API_KEY')
		expect(JSON.stringify(worker.options)).not.toContain('private-resend-key')

		const noFrom = { ...resend }
		delete noFrom['FABRIKA_EMAIL_FROM']
		expect(() => buildPropustkaWorker({ env: 'prod', domain: REMOTE_DOMAIN }, noFrom)).toThrow('FABRIKA_EMAIL_FROM')
		const noKey = { ...resend }
		delete noKey['FABRIKA_EMAIL_RESEND_API_KEY']
		expect(() => buildPropustkaWorker({ env: 'prod', domain: REMOTE_DOMAIN }, noKey)).toThrow('FABRIKA_EMAIL_RESEND_API_KEY')
		expect(() => iamPipelineVars({ ...REMOTE_SOURCE, FABRIKA_EMAIL_PROVIDER: 'smtp' })).toThrow(
			'FABRIKA_EMAIL_PROVIDER must be none or resend',
		)
	})

	test('remote secrets are required but never enter plaintext Worker vars', () => {
		const worker = buildPropustkaWorker({ env: 'prod', domain: REMOTE_DOMAIN }, REMOTE_SOURCE)
		const serializedOptions = JSON.stringify(worker.options)

		expect(worker.options.vars?.['FABRIKA_IAM_SIGNING_KEYS']).toBeUndefined()
		expect(worker.options.vars?.['OIDC_CLIENT_SECRET']).toBeUndefined()
		expect(worker.options.vars?.['FABRIKA_EMAIL_RESEND_API_KEY']).toBeUndefined()
		expect(serializedOptions).not.toContain(REMOTE_SOURCE['FABRIKA_IAM_SIGNING_KEYS'])
		expect(serializedOptions).not.toContain(REMOTE_SOURCE['OIDC_CLIENT_SECRET'])
	})

	test('unknown environments fail through both entry paths', () => {
		expect(() => config.resources({ env: 'preview', domain: REMOTE_DOMAIN })).toThrow('Unknown environment preview')
		expect(() => oblakaDefinition({ env: 'preview' })).toThrow('Unknown environment preview')
	})
})
