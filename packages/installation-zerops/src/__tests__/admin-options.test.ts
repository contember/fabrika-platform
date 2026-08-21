import { describe, expect, test } from 'bun:test'
import { parsePlatformAdminArgs, REISSUE_FLAG } from '../admin-options'

const env = { FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning' }

describe('platform admin options', () => {
	test('takes the mailbox, the IAM host and the scheme, and reads the key from the environment', () => {
		expect(parsePlatformAdminArgs(['--email=operator@example.test', '--iam-host=iam.example.test'], env)).toEqual({
			email: 'operator@example.test',
			iamHost: 'iam.example.test',
			scheme: 'https',
			provisioningKey: 'px_provisioning',
			reissue: false,
		})
	})

	test('a flag beats the variable beside it', () => {
		const parsed = parsePlatformAdminArgs(['--email=flag@example.test', '--scheme=http'], {
			...env,
			FABRIKA_PLATFORM_ADMIN_EMAIL: 'variable@example.test',
			FABRIKA_PLATFORM_IAM_HOST: 'iam.example.test',
			FABRIKA_PLATFORM_SCHEME: 'https',
		})
		expect(parsed.email).toBe('flag@example.test')
		expect(parsed.scheme).toBe('http')
		expect(parsed.iamHost).toBe('iam.example.test')
	})

	test('names both the flag and the variable for every value it cannot do without', () => {
		expect(() => parsePlatformAdminArgs([], env)).toThrow('--email=<value> or FABRIKA_PLATFORM_ADMIN_EMAIL is required')
		expect(() => parsePlatformAdminArgs(['--email=operator@example.test'], env)).toThrow(
			'--iam-host=<value> or FABRIKA_PLATFORM_IAM_HOST is required',
		)
		expect(() => parsePlatformAdminArgs(['--email=operator@example.test', '--iam-host=iam.example.test'], {})).toThrow(
			'FABRIKA_IAM_PROVISIONING_KEY is required. It has no flag: the key platform install printed comes from the environment only.',
		)
	})

	test('the credential has no flag, so it cannot reach a shell history', () => {
		expect(() => parsePlatformAdminArgs(['--email=operator@example.test', '--iam-host=iam.example.test', '--key=px_leak'], env)).toThrow(
			'unexpected argument `--key=px_leak`',
		)
	})

	test('refuses a host carrying a scheme or a port — the origin is composed from host and scheme', () => {
		expect(() => parsePlatformAdminArgs(['--email=o@example.test', '--iam-host=https://iam.example.test'], env)).toThrow(
			'is not a bare hostname',
		)
		expect(() => parsePlatformAdminArgs(['--email=o@example.test', '--iam-host=iam.example.test:8443'], env)).toThrow(
			'is not a bare hostname',
		)
	})

	test('refuses a scheme that is neither http nor https', () => {
		expect(() => parsePlatformAdminArgs(['--email=o@example.test', '--iam-host=iam.example.test', '--scheme=ftp'], env)).toThrow(
			'--scheme must be http or https',
		)
	})

	test(`${REISSUE_FLAG} is a value-less flag and has no variable beside it`, () => {
		const parsed = parsePlatformAdminArgs(['--email=o@example.test', '--iam-host=iam.example.test', REISSUE_FLAG], env)
		expect(parsed.reissue).toBe(true)
	})

	test('refuses a repeated flag rather than picking one', () => {
		expect(() => parsePlatformAdminArgs(['--email=a@example.test', '--email=b@example.test', '--iam-host=iam.example.test'], env)).toThrow(
			'--email was given more than once',
		)
	})
})
