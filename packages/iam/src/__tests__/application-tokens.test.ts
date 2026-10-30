import { type AccessTokenClaims, appEnvironmentId, parseAccessClaims, permits } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { hashToken } from '../secret'
import { getSigner } from '../signing'
import { mintFromKey, mintToken } from '../tokens'
import { createHarness, type Harness, seedInlineGrant, seedService, seedUser } from './helpers/harness'

// ADR-0022 rule 6: an application token carries only the grants of its own app id `<app>@<env>`.
// Cross-app grants and the bootstrap `admin` reach the platform audiences and nothing else.

const ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ISSUER = 'https://iam.test'
const PROD = appEnvironmentId('notes', 'prod')
const STAGE = appEnvironmentId('notes', 'stage')
const BOOTSTRAP_EMAIL = 'boss@platform.test'

async function sessionFor(h: Harness, principalId: string): Promise<string> {
	return h.signSession(principalId, { email: BOOTSTRAP_EMAIL })
}

async function claimsOf(token: string, audience: string): Promise<AccessTokenClaims> {
	const { payload } = await jwtVerify(token, createLocalJWKSet((await getSigner(ENV)).jwks()), { issuer: ISSUER, audience })
	const claims = parseAccessClaims(payload)
	if (claims === null) throw new Error('expected access claims')
	return claims
}

async function mintedPermissions(h: Harness, principalId: string, app: string) {
	const services = h.makeServices({ issuer: ISSUER, bootstrapAdmins: new Set([BOOTSTRAP_EMAIL]) })
	const { result } = await mintToken(services, ENV, { app, session: await sessionFor(h, principalId), requestId: 'r' })
	if (!result.ok) throw new Error(`mint failed: ${result.reason}`)
	return (await claimsOf(result.token, app)).perms
}

describe('an application token', () => {
	test('a bootstrap admin holds the global admin at a platform audience and nothing at an application', async () => {
		const h = createHarness()
		const boss = seedUser(h.sqlite, { sub: 'boss', email: BOOTSTRAP_EMAIL })

		expect(permits(await mintedPermissions(h, boss, 'vozka'), 'deploy.trigger')).toBe(true)
		expect(await mintedPermissions(h, boss, PROD)).toEqual([])
	})

	test('a cross-app grant reaches a platform audience and never an application', async () => {
		const h = createHarness()
		const operator = seedUser(h.sqlite, { sub: 'op', email: 'op@platform.test' })
		seedInlineGrant(h.sqlite, operator, ['*'], null, null)

		expect(permits(await mintedPermissions(h, operator, 'operations'), 'issue.read')).toBe(true)
		expect(await mintedPermissions(h, operator, PROD)).toEqual([])
	})

	test('carries the grants of its own app id, and a staging grant does not reach production', async () => {
		const h = createHarness()
		const member = seedUser(h.sqlite, { sub: 'm', email: 'member@notes.test' })
		seedInlineGrant(h.sqlite, member, ['note.read'], null, PROD)
		seedInlineGrant(h.sqlite, member, ['note.delete'], null, STAGE)

		const perms = await mintedPermissions(h, member, PROD)
		expect(permits(perms, 'note.read')).toBe(true)
		expect(permits(perms, 'note.delete')).toBe(false)
	})

	test('a staging key is refused at production', async () => {
		const h = createHarness()
		const service = seedService(h.sqlite, { commonName: 'notes-ci' })
		seedInlineGrant(h.sqlite, service, ['note.read'], null, STAGE)
		const key = 'px_staging-key'
		await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			principalId: service,
			app: STAGE,
			issuedBy: service,
			grants: [],
		})
		const services = h.makeServices({ issuer: ISSUER })

		expect((await mintFromKey(services, ENV, { app: STAGE, key, requestId: 'stage' })).result.ok).toBe(true)
		expect((await mintFromKey(services, ENV, { app: PROD, key, requestId: 'prod' })).result).toEqual({ ok: false, reason: 'invalid_key' })
	})

	test('a cross-app service key mints at an application with only that application’s grants', async () => {
		const h = createHarness()
		const service = seedService(h.sqlite, { commonName: 'platform-bot' })
		seedInlineGrant(h.sqlite, service, ['*'], null, null)
		const key = 'px_cross-app-key'
		await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			principalId: service,
			app: null,
			issuedBy: service,
			grants: [],
		})
		const services = h.makeServices({ issuer: ISSUER })

		const minted = await mintFromKey(services, ENV, { app: PROD, key, requestId: 'prod' })
		if (!minted.result.ok) throw new Error('expected a token')
		expect((await claimsOf(minted.result.token, PROD)).perms).toEqual([])
	})
})
