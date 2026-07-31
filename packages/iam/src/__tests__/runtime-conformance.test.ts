import { assertAppRuntimeConformance } from '@fabrika/app/testing'
import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { iamApp } from '../app'
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
		PROPUSTKA_SIGNING_KEYS: '',
		PROPUSTKA_PROVISIONING_KEY: '',
		SESSION_COOKIE_DOMAIN: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: '',
		OIDC_CLIENT_SECRET: '',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

describe('IAM runtime conformance', () => {
	test('serves the public Worker surface identically through every adapter', async () => {
		const response = await assertAppRuntimeConformance({
			app: iamApp,
			createEnv: env,
			createRequest: () => new Request('http://localhost:18191/.well-known/jwks.json'),
		})

		expect(response.status).toBe(200)
		expect(response.headers).toContainEqual(['content-type', 'application/json;charset=utf-8'])
	})
})
