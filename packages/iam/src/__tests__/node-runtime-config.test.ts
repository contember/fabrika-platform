import { describe, expect, test } from 'bun:test'
import { createRuntime } from '../node/runtime'

const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/iam'
const CANONICAL_RPC_KEY = 'canonical-rpc-key-with-at-least-32-characters'
const CANONICAL_PROXY_KEY = 'canonical-proxy-key-with-at-least-32-characters'
const LEGACY_RPC_KEY = 'legacy-rpc-key-with-at-least-32-characters'
const LEGACY_PROXY_KEY = 'legacy-proxy-key-with-at-least-32-characters'

const base = {
	ENVIRONMENT: 'local',
	ISSUER: 'http://localhost:18191',
	OIDC_ISSUER: 'https://oidc.example.com',
	OIDC_CLIENT_ID: 'client-id',
	OIDC_CLIENT_SECRET: 'private-oidc-secret',
}

describe('IAM Bun runtime environment aliases', () => {
	test('reads canonical configuration', async () => {
		const runtime = createRuntime({
			...base,
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			FABRIKA_IAM_RPC_KEY: CANONICAL_RPC_KEY,
			FABRIKA_IAM_PROXY_KEY: CANONICAL_PROXY_KEY,
			FABRIKA_IAM_SIGNING_KEYS: 'canonical-signing',
			FABRIKA_IAM_PROVISIONING_KEY: 'canonical-provisioning',
		})
		try {
			expect(runtime.config.rpcKey).toBe(CANONICAL_RPC_KEY)
			expect(runtime.config.proxyKey).toBe(CANONICAL_PROXY_KEY)
			expect(runtime.env.FABRIKA_IAM_SIGNING_KEYS).toBe('canonical-signing')
			expect(runtime.env.FABRIKA_IAM_PROVISIONING_KEY).toBe('canonical-provisioning')
			expect(runtime.env.OIDC_ENABLED).toBe('true')
			expect(runtime.env.PASSWORD_ENABLED).toBe('false')
			expect(runtime.env.EMAIL_PROVIDER).toBe('none')
		} finally {
			await runtime.shutdown()
		}
	})

	test('accepts legacy configuration', async () => {
		const runtime = createRuntime({
			...base,
			PROPUSTKA_DATABASE_URL: DATABASE_URL,
			PROPUSTKA_RPC_KEY: LEGACY_RPC_KEY,
			PROPUSTKA_PROXY_KEY: LEGACY_PROXY_KEY,
			PROPUSTKA_SIGNING_KEYS: 'legacy-signing',
			PROPUSTKA_PROVISIONING_KEY: 'legacy-provisioning',
		})
		try {
			expect(runtime.config.rpcKey).toBe(LEGACY_RPC_KEY)
			expect(runtime.config.proxyKey).toBe(LEGACY_PROXY_KEY)
			expect(runtime.env.FABRIKA_IAM_SIGNING_KEYS).toBe('legacy-signing')
			expect(runtime.env.FABRIKA_IAM_PROVISIONING_KEY).toBe('legacy-provisioning')
		} finally {
			await runtime.shutdown()
		}
	})

	test('canonical configuration wins when both names are set', async () => {
		const runtime = createRuntime({
			...base,
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			PROPUSTKA_DATABASE_URL: 'postgres://legacy:legacy@127.0.0.1:2/iam',
			FABRIKA_IAM_RPC_KEY: CANONICAL_RPC_KEY,
			PROPUSTKA_RPC_KEY: LEGACY_RPC_KEY,
			FABRIKA_IAM_PROXY_KEY: CANONICAL_PROXY_KEY,
			PROPUSTKA_PROXY_KEY: LEGACY_PROXY_KEY,
			FABRIKA_IAM_SIGNING_KEYS: 'canonical-signing',
			PROPUSTKA_SIGNING_KEYS: 'legacy-signing',
			FABRIKA_IAM_PROVISIONING_KEY: 'canonical-provisioning',
			PROPUSTKA_PROVISIONING_KEY: 'legacy-provisioning',
		})
		try {
			expect(runtime.config.rpcKey).toBe(CANONICAL_RPC_KEY)
			expect(runtime.config.proxyKey).toBe(CANONICAL_PROXY_KEY)
			expect(runtime.env.FABRIKA_IAM_SIGNING_KEYS).toBe('canonical-signing')
			expect(runtime.env.FABRIKA_IAM_PROVISIONING_KEY).toBe('canonical-provisioning')
		} finally {
			await runtime.shutdown()
		}
	})

	test('reports the canonical database name when neither alias is set', () => {
		expect(() => createRuntime(base)).toThrow('FABRIKA_IAM_DATABASE_URL is required')
	})

	test('supports password-only authentication without OIDC configuration', async () => {
		const runtime = createRuntime({
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			ENVIRONMENT: 'local',
			ISSUER: 'http://localhost:18191',
			FABRIKA_IAM_OIDC_ENABLED: 'false',
			FABRIKA_IAM_PASSWORD_ENABLED: 'true',
		})
		try {
			expect(runtime.env.OIDC_ENABLED).toBe('false')
			expect(runtime.env.PASSWORD_ENABLED).toBe('true')
			expect(runtime.env.OIDC_ISSUER).toBe('')
		} finally {
			await runtime.shutdown()
		}
	})

	test('rejects disabled and invalid authentication methods', () => {
		expect(() =>
			createRuntime({
				...base,
				FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
				FABRIKA_IAM_OIDC_ENABLED: 'false',
				FABRIKA_IAM_PASSWORD_ENABLED: 'false',
			})
		).toThrow('At least one IAM authentication method must be enabled')
		expect(() =>
			createRuntime({
				...base,
				FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
				FABRIKA_IAM_PASSWORD_ENABLED: 'yes',
			})
		).toThrow('FABRIKA_IAM_PASSWORD_ENABLED must be true or false')
	})

	test('requires and maps Resend configuration only when enabled', async () => {
		const source = {
			...base,
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			FABRIKA_EMAIL_PROVIDER: 'resend',
			FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>',
			FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
		}
		const runtime = createRuntime(source)
		try {
			expect(runtime.env.EMAIL_PROVIDER).toBe('resend')
			expect(runtime.env.EMAIL_FROM).toBe('Fabrika <auth@example.com>')
			expect(runtime.env.EMAIL_API_KEY).toBe('private-resend-key')
		} finally {
			await runtime.shutdown()
		}

		expect(() => createRuntime({ ...source, FABRIKA_EMAIL_FROM: '' })).toThrow('FABRIKA_EMAIL_FROM is required')
		expect(() => createRuntime({ ...source, FABRIKA_EMAIL_RESEND_API_KEY: '' })).toThrow('FABRIKA_EMAIL_RESEND_API_KEY is required')
		expect(() => createRuntime({ ...source, FABRIKA_EMAIL_PROVIDER: 'smtp' })).toThrow('FABRIKA_EMAIL_PROVIDER must be none or resend')
	})
})
