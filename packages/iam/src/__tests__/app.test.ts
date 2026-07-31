import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createIamApp, iamApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'

const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

function env(): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: createHarness().repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'local',
		ISSUER: 'http://localhost:18191',
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		SESSION_COOKIE_DOMAIN: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: '',
		OIDC_CLIENT_SECRET: '',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

const exec = { waitUntil() {} }

describe('iamApp', () => {
	test('serves the public JWKS through the shared application', async () => {
		const response = await iamApp.fetch(new Request('http://localhost:18191/.well-known/jwks.json'), env(), exec)
		const head = await iamApp.fetch(
			new Request('http://localhost:18191/.well-known/jwks.json', { method: 'HEAD' }),
			env(),
			exec,
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('application/json')
		expect(head.status).toBe(200)
	})

	test('the Bun composition mounts liveness without changing the Worker application', async () => {
		const response = await createIamApp({ health: true }).fetch(new Request('http://localhost:18191/healthz'), env(), exec)
		const post = await createIamApp({ health: true }).fetch(
			new Request('http://localhost:18191/healthz', { method: 'POST' }),
			env(),
			exec,
		)

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('{"status":"ok"}')
		expect(post.status).toBe(200)
	})
})
