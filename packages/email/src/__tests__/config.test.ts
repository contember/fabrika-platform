import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { EmailDeliveryError } from '../email.js'
import { type EmailProvider, emailSenderFromEnv, parseProviderVariables, pickEmailEnvironment, readEmailTransportConfig } from '../index.js'
import { MemoryEmailSender } from '../memory.js'
import { builtinEmailProviders } from '../providers.js'
import { ResendEmailSender } from '../resend.js'

const RESEND = { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'auth@example.test', FABRIKA_EMAIL_RESEND_API_KEY: 're_private_key' }

function refusal(run: () => unknown): EmailDeliveryError {
	try {
		run()
	} catch (error) {
		if (error instanceof EmailDeliveryError) return error
		throw error
	}
	throw new Error('Expected an EmailDeliveryError')
}

describe('readEmailTransportConfig', () => {
	test.each([{}, { FABRIKA_EMAIL_PROVIDER: 'none' }, { FABRIKA_EMAIL_PROVIDER: '' }])('an absent or none provider is no transport', (env) => {
		expect(readEmailTransportConfig(env, builtinEmailProviders)).toEqual({ kind: 'none' })
		expect(emailSenderFromEnv(env, builtinEmailProviders)).toBeNull()
	})

	test('an unknown provider names the registry', () => {
		const error = refusal(() => readEmailTransportConfig({ FABRIKA_EMAIL_PROVIDER: 'smtp' }, builtinEmailProviders))
		expect(error.code).toBe('invalid_configuration')
		expect(error.message).toBe('FABRIKA_EMAIL_PROVIDER must be none or one of: ahasend, cloudflare, lettermint, postmark, resend, smartemailing')
	})

	test('a name an object inherits is not a provider', () => {
		expect(() => readEmailTransportConfig({ FABRIKA_EMAIL_PROVIDER: 'constructor' }, builtinEmailProviders)).toThrow('must be none or one of')
	})

	test('lists every missing variable in one refusal', () => {
		const error = refusal(() => readEmailTransportConfig({ FABRIKA_EMAIL_PROVIDER: 'smartemailing' }, builtinEmailProviders))
		expect(error.message).toBe(
			'Email configuration is invalid: FABRIKA_EMAIL_FROM is missing; FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing; FABRIKA_EMAIL_SMARTEMAILING_API_KEY is missing',
		)
	})

	test('a bare address and the declared variables', () => {
		expect(readEmailTransportConfig({ ...RESEND, FABRIKA_EMAIL_FROM_NAME: 'Fabrika' }, builtinEmailProviders)).toEqual({
			kind: 'provider',
			provider: 'resend',
			from: { address: 'auth@example.test', name: 'Fabrika' },
			variables: [{ name: 'FABRIKA_EMAIL_RESEND_API_KEY', secret: true, required: true }],
		})
	})

	test.each([
		['Fabrika Auth <auth@example.test>', 'Fabrika Auth'],
		['"Fabrika, Auth" <auth@example.test>', 'Fabrika, Auth'],
	])('splits the legacy %s form', (from, name) => {
		const config = readEmailTransportConfig({ ...RESEND, FABRIKA_EMAIL_FROM: from }, builtinEmailProviders)
		expect(config).toMatchObject({ from: { address: 'auth@example.test', name } })
	})

	test('an empty value is an absent one for every variable', () => {
		const unset = { FABRIKA_EMAIL_FROM_NAME: '', FABRIKA_EMAIL_SMARTEMAILING_TAG: '' }
		expect(readEmailTransportConfig({ ...unset, FABRIKA_EMAIL_PROVIDER: '', FABRIKA_EMAIL_FROM: '' }, builtinEmailProviders)).toEqual({ kind: 'none' })
		expect(readEmailTransportConfig({ ...RESEND, ...unset }, builtinEmailProviders)).toMatchObject({ from: { address: 'auth@example.test' } })
		expect(() => readEmailTransportConfig({ ...RESEND, FABRIKA_EMAIL_FROM: '', FABRIKA_EMAIL_RESEND_API_KEY: '' }, builtinEmailProviders)).toThrow(
			'Email configuration is invalid: FABRIKA_EMAIL_FROM is missing; FABRIKA_EMAIL_RESEND_API_KEY is missing',
		)
		const smartEmailing = emailSenderFromEnv({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'auth@example.test',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'key',
			...unset,
		}, builtinEmailProviders)
		expect(smartEmailing?.capabilities.idempotent).toBe(false)
	})

	test('lists invalid provider values beside the missing variables, once per variable', () => {
		expect(() => readEmailTransportConfig({ FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_RESEND_API_KEY: 'has space' }, builtinEmailProviders))
			.toThrow(
				'Email configuration is invalid: FABRIKA_EMAIL_FROM is missing; FABRIKA_EMAIL_RESEND_API_KEY is missing or invalid',
			)
		expect(() =>
			readEmailTransportConfig({
				FABRIKA_EMAIL_PROVIDER: 'smartemailing',
				FABRIKA_EMAIL_FROM: 'auth@example.test',
				FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'with space',
				FABRIKA_EMAIL_SMARTEMAILING_TAG: 'no spaces allowed',
			}, builtinEmailProviders)
		).toThrow(
			'Email configuration is invalid: FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing; FABRIKA_EMAIL_SMARTEMAILING_API_KEY is missing or invalid; FABRIKA_EMAIL_SMARTEMAILING_TAG is missing or invalid',
		)
	})

	test("merges an external provider's refusal, from parseProviderVariables or its own fixed message", () => {
		const sender = new MemoryEmailSender()
		const keyed: EmailProvider = {
			variables: [{ name: 'FABRIKA_EMAIL_RELAY_TOKEN', secret: true, required: false }],
			create({ env }) {
				parseProviderVariables(z.object({ FABRIKA_EMAIL_RELAY_TOKEN: z.string().regex(/^tok_/) }), env)
				return sender
			},
		}
		const fixed: EmailProvider = {
			variables: [],
			create() {
				throw new EmailDeliveryError('The relay endpoint is invalid', { code: 'invalid_configuration' })
			},
		}
		const registry = { keyed, fixed }

		expect(() => readEmailTransportConfig({ FABRIKA_EMAIL_PROVIDER: 'keyed', FABRIKA_EMAIL_RELAY_TOKEN: 'private-token' }, registry)).toThrow(
			'Email configuration is invalid: FABRIKA_EMAIL_FROM is missing; FABRIKA_EMAIL_RELAY_TOKEN is missing or invalid',
		)
		expect(() => readEmailTransportConfig({ FABRIKA_EMAIL_PROVIDER: 'fixed', FABRIKA_EMAIL_FROM: 'auth@example.test' }, registry)).toThrow(
			'Email configuration is invalid: The relay endpoint is invalid',
		)
		expect(
			emailSenderFromEnv({ FABRIKA_EMAIL_PROVIDER: 'keyed', FABRIKA_EMAIL_FROM: 'auth@example.test', FABRIKA_EMAIL_RELAY_TOKEN: 'tok_1' }, registry),
		)
			.toBe(sender)
	})

	test('refuses FROM_NAME beside a FROM that already names the sender, and an invalid FROM', () => {
		expect(() =>
			readEmailTransportConfig({ ...RESEND, FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.test>', FABRIKA_EMAIL_FROM_NAME: 'Other' }, builtinEmailProviders)
		)
			.toThrow('FABRIKA_EMAIL_FROM_NAME is refused because FABRIKA_EMAIL_FROM already carries a display name')
		expect(() => readEmailTransportConfig({ ...RESEND, FABRIKA_EMAIL_FROM: 'not an address' }, builtinEmailProviders)).toThrow(
			'FABRIKA_EMAIL_FROM is invalid',
		)
		expect(() => readEmailTransportConfig({ ...RESEND, FABRIKA_EMAIL_FROM_NAME: 'Bad <name>' }, builtinEmailProviders)).toThrow(
			'FABRIKA_EMAIL_FROM_NAME is invalid',
		)
	})

	test('never puts a value into a refusal', () => {
		const secrets = ['re_private key', 'private-user:name', 'private-api key']
		const errors = [
			refusal(() => emailSenderFromEnv({ ...RESEND, FABRIKA_EMAIL_RESEND_API_KEY: 're_private key' }, builtinEmailProviders)),
			refusal(() =>
				emailSenderFromEnv({
					FABRIKA_EMAIL_PROVIDER: 'smartemailing',
					FABRIKA_EMAIL_FROM: 'private-from',
					FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'private-user:name',
					FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'private-api key',
				}, builtinEmailProviders)
			),
			refusal(() =>
				emailSenderFromEnv({
					FABRIKA_EMAIL_PROVIDER: 'smartemailing',
					FABRIKA_EMAIL_FROM: 'auth@example.test',
					FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'private-user:name',
					FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'private-api key',
				}, builtinEmailProviders)
			),
		]
		for (const error of errors) {
			expect(error.code).toBe('invalid_configuration')
			for (const secret of [...secrets, 'private-from']) expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(secret)
		}
		expect(errors[2]?.message).toContain('FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing or invalid')
	})
})

describe('emailSenderFromEnv', () => {
	test('builds the named provider with the injected fetch', async () => {
		let requests = 0
		const sender = emailSenderFromEnv(RESEND, builtinEmailProviders, {
			fetch: async () => {
				requests++
				return Response.json({ id: 'email-1' })
			},
		})
		expect(sender).toBeInstanceOf(ResendEmailSender)
		await sender?.send({ to: 'ada@example.test', subject: 'Hi', text: 'Hello.', idempotencyKey: 'k' }, new AbortController().signal)
		expect(requests).toBe(1)
	})

	test('an empty registry admits only none', () => {
		expect(() => emailSenderFromEnv(RESEND, {})).toThrow('FABRIKA_EMAIL_PROVIDER must be none or one of: ')
	})
})

describe('pickEmailEnvironment', () => {
	test('keeps only the non-empty string FABRIKA_EMAIL_ entries', () => {
		expect(pickEmailEnvironment({ FABRIKA_EMAIL_FROM: 'auth@example.test', FABRIKA_EMAIL_FROM_NAME: '', FABRIKA_EMAIL_FLAG: 1, DB: {}, OTHER: 'x' }))
			.toEqual({
				FABRIKA_EMAIL_FROM: 'auth@example.test',
			})
	})
})
