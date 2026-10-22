import { builtinEmailProviders } from '@fabrika/email/providers'
import { describe, expect, test } from 'bun:test'
import { readInstallationEmail } from '../email'

const registry = builtinEmailProviders
const optional = { registry, required: false }
const required = { registry, required: true }

const capture = (read: () => unknown): string => {
	try {
		read()
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('expected a refusal')
}

describe('the installation mail transport', () => {
	test('an absent provider is none unless the installer requires one', () => {
		expect(readInstallationEmail([], {}, optional)).toEqual({ kind: 'none' })
		expect(() => readInstallationEmail([], {}, required)).toThrow('--email-provider=<value> or FABRIKA_EMAIL_PROVIDER is required')
		expect(readInstallationEmail(['--email-provider=none'], {}, required)).toEqual({ kind: 'none' })
	})

	test('a sender flag under provider none is refused', () => {
		expect(() => readInstallationEmail(['--email-provider=none', '--email-from=a@example.com'], {}, required)).toThrow(
			'--email-from was given, but the email provider is none',
		)
		expect(() => readInstallationEmail(['--email-from-name=Acme'], {}, optional)).toThrow(
			'--email-from-name was given, but the email provider is none',
		)
	})

	test('a missing variable is named', () => {
		expect(() => readInstallationEmail(['--email-provider=resend', '--email-from=a@example.com'], {}, required)).toThrow(
			'FABRIKA_EMAIL_RESEND_API_KEY is missing',
		)
		expect(() => readInstallationEmail(['--email-provider=resend'], { FABRIKA_EMAIL_RESEND_API_KEY: 're_key' }, required)).toThrow(
			'FABRIKA_EMAIL_FROM is missing',
		)
		expect(() => readInstallationEmail(['--email-provider=smtp'], {}, required)).toThrow('FABRIKA_EMAIL_PROVIDER must be none or one of')
	})

	test('a secret value never appears in a refusal', () => {
		const secret = 'se-secret-value-1234'
		const message = capture(() =>
			readInstallationEmail(['--email-provider=smartemailing', '--email-from=not an address'], {
				FABRIKA_EMAIL_SMARTEMAILING_USERNAME: secret,
				FABRIKA_EMAIL_SMARTEMAILING_API_KEY: secret,
			}, required)
		)
		expect(message).toContain('FABRIKA_EMAIL_FROM is invalid')
		expect(message).not.toContain(secret)
	})

	test('SmartEmailing collects each of its variables, and secretNames holds exactly the secret ones', () => {
		const email = readInstallationEmail(['--email-provider=smartemailing', '--email-from-name=Acme Mail'], {
			FABRIKA_EMAIL_FROM: 'mail@example.com',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.com',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
			FABRIKA_EMAIL_SMARTEMAILING_TAG: 'fabrika',
			FABRIKA_EMAIL_RESEND_API_KEY: 'stale-resend-key',
		}, optional)
		if (email.kind !== 'provider') throw new Error('expected a provider')
		expect(Object.fromEntries(email.variables)).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'mail@example.com',
			FABRIKA_EMAIL_FROM_NAME: 'Acme Mail',
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.com',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-key',
			FABRIKA_EMAIL_SMARTEMAILING_TAG: 'fabrika',
		})
		expect([...email.secretNames].sort()).toEqual(['FABRIKA_EMAIL_SMARTEMAILING_API_KEY', 'FABRIKA_EMAIL_SMARTEMAILING_USERNAME'])
	})

	test('the flag beats the variable beside it', () => {
		const email = readInstallationEmail(['--email-provider=resend', '--email-from=flag@example.com'], {
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'env@example.com',
			FABRIKA_EMAIL_RESEND_API_KEY: 're_key',
		}, required)
		if (email.kind !== 'provider') throw new Error('expected a provider')
		expect(Object.fromEntries(email.variables)).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'resend',
			FABRIKA_EMAIL_FROM: 'flag@example.com',
			FABRIKA_EMAIL_RESEND_API_KEY: 're_key',
		})
		expect([...email.secretNames]).toEqual(['FABRIKA_EMAIL_RESEND_API_KEY'])
	})
})
