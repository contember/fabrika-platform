import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createRuntime } from '../node/runtime'
import { buildServices, DEFAULT_ADMIN_AUDIENCES } from '../services'
import { createHarness } from './helpers/harness'

// `ADMIN_AUDIENCES` is the registry `resolveAdmin`'s JWT branch checks `aud` against (SEC-A3-1); the
// admission behaviour itself is pinned in admin-router.test.ts. This file pins the two ends of the
// wire: how the value parses at boot, and that the Bun composition passes it through unset.

const ISSUER = 'https://iam.example.com'

function audiences(adminAudiences?: string): ReadonlySet<string> {
	const h = createHarness()
	return buildServices({
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: '[]',
		ADMIN_AUDIENCES: adminAudiences,
		ENVIRONMENT: 'stage',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
	}).config.adminAudiences
}

describe('ADMIN_AUDIENCES', () => {
	test('unset falls back to the console gateway, which is the only first-party caller', () => {
		expect(audiences()).toEqual(DEFAULT_ADMIN_AUDIENCES)
		expect([...DEFAULT_ADMIN_AUDIENCES]).toEqual(['vozka'])
	})

	test('an explicitly empty value is an EMPTY registry, not the default — no JWT may administer', () => {
		expect(audiences('')).toEqual(new Set())
		expect(audiences('   ')).toEqual(new Set())
	})

	test('a comma-separated list is trimmed and de-duplicated', () => {
		expect(audiences('vozka, other-gateway ,vozka')).toEqual(new Set(['vozka', 'other-gateway']))
	})

	test('a value that is not an app id is REFUSED at boot rather than skipped', () => {
		// A skipped entry silently narrows the registry, which locks the console out with no signal —
		// and a JSON array copied from ADMIN_ORIGINS would parse into entries no `aud` can ever equal.
		expect(() => audiences('vozka,,other')).toThrow('ADMIN_AUDIENCES')
		expect(() => audiences('vozka other')).toThrow('ADMIN_AUDIENCES')
		expect(() => audiences('["vozka"]')).toThrow('ADMIN_AUDIENCES')
		expect(() => audiences('https://console.example.com')).toThrow('ADMIN_AUDIENCES')
		expect(() => audiences('Vozka')).toThrow('ADMIN_AUDIENCES')
	})
})

describe('the Bun composition passes ADMIN_AUDIENCES through', () => {
	const base = {
		ENVIRONMENT: 'local',
		ISSUER: 'http://localhost:18191',
		FABRIKA_IAM_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/iam',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
		FABRIKA_IAM_OIDC_ENABLED: 'false',
	}

	test('unset stays undefined, so the default applies rather than an empty registry', async () => {
		const runtime = createRuntime(base)
		try {
			expect(runtime.env.ADMIN_AUDIENCES).toBeUndefined()
		} finally {
			await runtime.shutdown()
		}
	})

	test('an explicit value reaches the env verbatim', async () => {
		const runtime = createRuntime({ ...base, FABRIKA_IAM_ADMIN_AUDIENCES: 'vozka,console' })
		try {
			expect(runtime.env.ADMIN_AUDIENCES).toBe('vozka,console')
		} finally {
			await runtime.shutdown()
		}
	})
})
