import { D1Database, Worker } from '@fabrika/provider-cloudflare'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import config, { buildPropustkaWorker } from './fabrika.config'
import oblakaDefinition from './oblaka'

const REMOTE_SOURCE: Record<string, string> = {
	PROPUSTKA_HUMAN_EMAIL_DOMAINS: '["example.com"]',
	PROPUSTKA_OIDC_ISSUER: 'https://oidc.example.com',
	PROPUSTKA_OIDC_CLIENT_ID: 'client-id',
	PROPUSTKA_SIGNING_KEYS: 'private-signing-key-material',
	OIDC_CLIENT_SECRET: 'private-oidc-secret',
}
const REMOTE_DOMAIN = 'iam.example.com'
const ENV_NAMES = [...Object.keys(REMOTE_SOURCE), 'PROPUSTKA_HOSTNAME']
const originalEnvironment = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))

beforeEach(() => {
	for (const name of ENV_NAMES) {
		delete process.env[name]
	}
	for (const [name, value] of Object.entries(REMOTE_SOURCE)) {
		process.env[name] = value
	}
	process.env['PROPUSTKA_HOSTNAME'] = REMOTE_DOMAIN
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

		expect(() => buildPropustkaWorker({ env: 'stage' }, REMOTE_SOURCE)).toThrow('PROPUSTKA_HOSTNAME')
	})

	test('remote secrets are required but never enter plaintext Worker vars', () => {
		const worker = buildPropustkaWorker({ env: 'prod', domain: REMOTE_DOMAIN }, REMOTE_SOURCE)
		const serializedOptions = JSON.stringify(worker.options)

		expect(worker.options.vars?.['PROPUSTKA_SIGNING_KEYS']).toBeUndefined()
		expect(worker.options.vars?.['OIDC_CLIENT_SECRET']).toBeUndefined()
		expect(serializedOptions).not.toContain(REMOTE_SOURCE['PROPUSTKA_SIGNING_KEYS'])
		expect(serializedOptions).not.toContain(REMOTE_SOURCE['OIDC_CLIENT_SECRET'])
	})

	test('unknown environments fail through both entry paths', () => {
		expect(() => config.resources({ env: 'preview', domain: REMOTE_DOMAIN })).toThrow('Unknown environment preview')
		expect(() => oblakaDefinition({ env: 'preview' })).toThrow('Unknown environment preview')
	})
})
