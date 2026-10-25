import { MemoryEmailSender } from '@fabrika/email/memory'
import { builtinEmailProviders } from '@fabrika/email/providers'
import { describe, expect, test } from 'bun:test'
import { createRuntime } from '../node/runtime'
import { buildServices } from '../services'

const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/iam'
const RPC_KEY = 'rpc-key-with-at-least-thirty-two-characters'
const PROXY_KEY = 'proxy-key-with-at-least-thirty-two-characters'

const base = {
	ENVIRONMENT: 'local',
	ISSUER: 'http://localhost:18191',
	OIDC_ISSUER: 'https://oidc.example.com',
	OIDC_CLIENT_ID: 'client-id',
	OIDC_CLIENT_SECRET: 'private-oidc-secret',
}

describe('the IAM Bun runtime environment', () => {
	test('reads its configuration', async () => {
		const runtime = await createRuntime({
			...base,
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			FABRIKA_IAM_RPC_KEY: RPC_KEY,
			FABRIKA_IAM_PROXY_KEY: PROXY_KEY,
			FABRIKA_IAM_SIGNING_KEYS: 'signing-key-material',
			FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		})
		try {
			expect(runtime.config.rpcKey).toBe(RPC_KEY)
			expect(runtime.config.proxyKey).toBe(PROXY_KEY)
			expect(runtime.env.FABRIKA_IAM_SIGNING_KEYS).toBe('signing-key-material')
			expect(runtime.env.FABRIKA_IAM_PROVISIONING_KEY).toBe('px_provisioning')
			expect(runtime.env.OIDC_ENABLED).toBe('true')
			expect(runtime.env.PASSWORD_ENABLED).toBe('false')
			expect(runtime.env.EMAIL_CONFIG).toEqual({})
			expect(runtime.env.EMAIL_PROVIDERS).toBe(builtinEmailProviders)
			expect(buildServices(runtime.env).email).toBeNull()
		} finally {
			await runtime.shutdown()
		}
	})

	test('names the variable it needs when the database URL is unset', async () => {
		await expect(createRuntime(base)).rejects.toThrow('FABRIKA_IAM_DATABASE_URL is required')
	})

	test('supports password-only authentication without OIDC configuration', async () => {
		const runtime = await createRuntime({
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

	test('rejects disabled and invalid authentication methods', async () => {
		await expect(
			createRuntime({
				...base,
				FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
				FABRIKA_IAM_OIDC_ENABLED: 'false',
				FABRIKA_IAM_PASSWORD_ENABLED: 'false',
			}),
		).rejects.toThrow('At least one IAM authentication method must be enabled')
		await expect(
			createRuntime({
				...base,
				FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
				FABRIKA_IAM_PASSWORD_ENABLED: 'yes',
			}),
		).rejects.toThrow('FABRIKA_IAM_PASSWORD_ENABLED must be true or false')
	})

	test('requires and maps Resend configuration only when enabled', async () => {
		const source = {
			...base,
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			FABRIKA_EMAIL_PROVIDER: 'resend',
			FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>',
			FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
		}
		const runtime = await createRuntime(source)
		try {
			expect(runtime.env.EMAIL_CONFIG).toEqual({
				FABRIKA_EMAIL_PROVIDER: 'resend',
				FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>',
				FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
			})
			expect(buildServices(runtime.env).email?.capabilities.idempotent).toBe(true)
		} finally {
			await runtime.shutdown()
		}

		await expect(createRuntime({ ...source, FABRIKA_EMAIL_FROM: '' })).rejects.toThrow('FABRIKA_EMAIL_FROM is missing')
		await expect(createRuntime({ ...source, FABRIKA_EMAIL_RESEND_API_KEY: '' })).rejects.toThrow('FABRIKA_EMAIL_RESEND_API_KEY is missing')
		await expect(createRuntime({ ...source, FABRIKA_EMAIL_PROVIDER: 'smtp' })).rejects.toThrow(
			'FABRIKA_EMAIL_PROVIDER must be none or one of: ahasend, cloudflare, lettermint, postmark, resend, smartemailing',
		)
	})

	test('a composition may name its own provider registry', async () => {
		const sender = new MemoryEmailSender()
		const source = { ...base, FABRIKA_IAM_DATABASE_URL: DATABASE_URL, FABRIKA_EMAIL_PROVIDER: 'stand-in', FABRIKA_EMAIL_FROM: 'auth@example.com' }
		const runtime = await createRuntime(source, { emailProviders: { 'stand-in': { variables: [], create: () => sender } } })
		try {
			expect(buildServices(runtime.env).email).toBe(sender)
		} finally {
			await runtime.shutdown()
		}
		await expect(createRuntime(source)).rejects.toThrow(
			'FABRIKA_EMAIL_PROVIDER must be none or one of: ahasend, cloudflare, lettermint, postmark, resend, smartemailing',
		)
	})

	test('a composition email sender serves only a local IAM with no provider configured', async () => {
		const sender = new MemoryEmailSender()
		const source = { ...base, FABRIKA_IAM_DATABASE_URL: DATABASE_URL }
		const runtime = await createRuntime(source, { emailSender: sender })
		try {
			expect(runtime.env.EMAIL_SENDER).toBe(sender)
			expect(buildServices(runtime.env).email).toBe(sender)
			expect(() => buildServices({ ...runtime.env, ENVIRONMENT: 'stage' })).toThrow('A composition email sender is local-only')
			expect(() =>
				buildServices({
					...runtime.env,
					EMAIL_CONFIG: { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'auth@example.com', FABRIKA_EMAIL_RESEND_API_KEY: 're_key' },
				})
			).toThrow('which must then be none')
		} finally {
			await runtime.shutdown()
		}

		const refusal = 'A composition email sender needs ENVIRONMENT=local and FABRIKA_EMAIL_PROVIDER=none'
		await expect(createRuntime({ ...source, ENVIRONMENT: 'stage', ISSUER: 'https://iam.example.com' }, { emailSender: sender })).rejects.toThrow(
			refusal,
		)
		await expect(
			createRuntime({
				...source,
				FABRIKA_EMAIL_PROVIDER: 'resend',
				FABRIKA_EMAIL_FROM: 'auth@example.com',
				FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
			}, { emailSender: sender }),
		).rejects.toThrow(refusal)
	})

	test('maps the retention settings, and a bad value refuses the boot', async () => {
		const runtime = await createRuntime({
			...base,
			FABRIKA_IAM_DATABASE_URL: DATABASE_URL,
			FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS: '14',
			FABRIKA_IAM_AUDIT_RETENTION_DAYS: '365',
		})
		try {
			expect(runtime.env.AUTH_LOG_RETENTION_DAYS).toBe('14')
			expect(runtime.env.AUDIT_RETENTION_DAYS).toBe('365')
		} finally {
			await runtime.shutdown()
		}

		const source = { ...base, FABRIKA_IAM_DATABASE_URL: DATABASE_URL }
		await expect(createRuntime({ ...source, FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS: '30d' })).rejects.toThrow(
			'FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS must be a whole number',
		)
		await expect(createRuntime({ ...source, FABRIKA_IAM_AUDIT_RETENTION_DAYS: '0' })).rejects.toThrow(
			'FABRIKA_IAM_AUDIT_RETENTION_DAYS must be a whole number',
		)
	})
})
