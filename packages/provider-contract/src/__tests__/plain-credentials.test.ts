import { describe, expect, test } from 'bun:test'
import { plainCredentialFinding } from '..'

// Token-shaped fixtures are assembled at run time, so no file in the repository carries a string a secret scanner
// would take for a live credential.
const join = (...parts: readonly string[]): string => parts.join('')
const RANDOM = 'q7Rk2LmX9vTz4NpB8sWc3YhD6fGj'
const RANDOM_BASE64 = 'kV8sQ2mZ+pL4wN7xR1tB/yH5cJ9fD3gA='

describe('plainCredentialFinding', () => {
	test.each([
		['FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN', '0f8c2a4e-1b3d-4c5e-8f7a-9b0c1d2e3f4a', 'TOKEN'],
		['DB_PASSWORD', 'hunter2', 'PASSWORD'],
		['STRIPE_SECRET', 'abc', 'SECRET'],
		['RESEND_API_KEY', 're_123', 'KEY'],
		['apiKey', 'abc', 'KEY'],
		['FABRIKA_IAM_KEY', 'abc', 'KEY'],
		['SMTP_PASSWD', 'abc', 'PASSWD'],
		['BASIC_AUTH_USERS', 'admin:hunter2', 'BASIC_AUTH'],
		['basicAuth', 'admin:hunter2', 'BASIC_AUTH'],
		['GOOGLE_APPLICATION_CREDENTIALS', '{"type":"service_account"}', 'CREDENTIALS'],
		['GITHUB_WEBHOOK_SECRET', 'abc', 'SECRET'],
	])('the name %s is a credential name', (name, value, word) => {
		expect(plainCredentialFinding(name, value)).toEqual({ basis: 'name', because: `its name contains \`${word}\`` })
	})

	test.each([
		['OAUTH_TOKEN_URL', 'https://example.com/token'],
		['PASSWORD_MIN_LENGTH', '12'],
		['SECRET_NAME', 'stripe'],
		['API_KEY_HEADER', 'X-Api-Key'],
		['S3_ACCESS_KEY_ID', 'AKIAEXAMPLE'],
		['RECAPTCHA_SITE_KEY', 'public'],
		['STRIPE_PUBLISHABLE_KEY', 'pk'],
		['PUBLIC_KEY', 'pk'],
		['CACHE_KEY', 'v2'],
		['KEYCLOAK_REALM', 'main'],
		['BASIC_AUTH_ENABLED', 'true'],
		['TOKEN_TTL', '3600'],
	])('the name %s describes a credential and does not hold one', (name, value) => {
		expect(plainCredentialFinding(name, value)).toBeNull()
	})

	test('a credential name whose value is only references holds nothing here', () => {
		expect(plainCredentialFinding('FABRIKA_STORAGE_SECRET_ACCESS_KEY', '${storage_secretAccessKey}')).toBeNull()
		expect(plainCredentialFinding('DB_PASSWORD', '${db_password}${db_suffix}')).toBeNull()
		expect(plainCredentialFinding('DB_PASSWORD', '')).toBeNull()
		expect(plainCredentialFinding('DB_PASSWORD', '  ')).toBeNull()
		expect(plainCredentialFinding('DB_PASSWORD', 'prefix-${db_password}')).toEqual({ basis: 'name', because: 'its name contains `PASSWORD`' })
	})

	test.each([
		['an Authorization header value', 'Basic YWRtaW46aHVudGVyMg==', 'it is an Authorization header value'],
		['a bearer header value', 'Bearer abcdefgh12345678', 'it is an Authorization header value'],
		['a URL with a password', 'postgres://app:hunter2@db:5432/app', 'its URL carries a password'],
		['a private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE', 'it holds a private key'],
		['a Fabrika key', 'px_abcdefgh12345678', 'it reads like a Fabrika key'],
		['a GitHub token', join('gh', 'p_', 'a'.repeat(36)), 'it reads like a GitHub token'],
		['a Stripe key', join('sk', '_live_', 'a'.repeat(24)), 'it reads like a Stripe key'],
		['a Slack token', join('xo', 'xb-', '1234567890-abcdef'), 'it reads like a Slack token'],
		['an AWS access key', join('AK', 'IA', 'ABCDEFGHIJKLMNOP'), 'it reads like an AWS access key'],
		['a JWT', join('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'c2lnbmF0dXJlMDA'), 'it reads like a signed JSON Web Token'],
		['a long random string', RANDOM, 'it is a long random string'],
		['a random base64 string', RANDOM_BASE64, 'it is a long random string'],
	])('the value alone gives away %s', (_kind, value, because) => {
		expect(plainCredentialFinding('SOMETHING', value)).toEqual({ basis: 'value', because })
	})

	test.each([
		['a URL without a password', 'postgres://app@db:5432/app'],
		['a URL whose password is a reference', 'postgres://app:${db_password}@db:5432/app'],
		['a UUID', '0f8c2a4e-1b3d-4c5e-8f7a-9b0c1d2e3f4a'],
		['a hex digest', 'a3f1c9e07b2d4f6a8c1e3b5d7f9a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a'],
		['a host', 'iam.example.com'],
		['a sentence', 'Fabrika <no-reply@example.com>'],
		['a JSON document', '{"clients":[{"id":"claude"}]}'],
		['a camel-case word', 'MyApplicationReportFinal2024'],
		['a short mixed string', 'Ab3Cd4Ef5'],
		['an upper-case hex digest', 'A3F1C9E07B2D4F6A8C1E3B5D7F9A0C2E'],
	])('the value %s is not one', (_kind, value) => {
		expect(plainCredentialFinding('SOMETHING', value)).toBeNull()
	})

	test('a finding never carries the value', () => {
		const finding = plainCredentialFinding('DB_PASSWORD', RANDOM)
		expect(JSON.stringify(finding)).not.toContain(RANDOM)
		expect(JSON.stringify(plainCredentialFinding('X', RANDOM))).not.toContain(RANDOM)
	})
})
