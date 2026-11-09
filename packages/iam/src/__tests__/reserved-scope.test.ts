// `~` scope types are IAM's derived pseudo-scopes (`~rel`): no grant names one at ingress, so a relation entry in a
// token always comes from a role's `via` on a global grant.

import { appEnvironmentId, parseAccessClaims } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { parseScope } from '../admin/grant-support'
import { hashToken } from '../secret'
import { getSigner } from '../signing'
import { mintFromKey } from '../tokens'
import { createHarness, seedInlineGrant, seedUser } from './helpers/harness'

const ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const ISSUER = 'https://iam.test'
const PROD = appEnvironmentId('notes', 'prod')

describe('a grant scope at ingress', () => {
	test('a reserved scope type is refused; a dimension and no scope are accepted', () => {
		expect(parseScope({ scopeType: '~rel', scopeValue: 'assignee' })).toEqual({ ok: false })
		expect(parseScope({ scopeType: '~other', scopeValue: 'x' })).toEqual({ ok: false })
		expect(parseScope({ scopeType: 'team', scopeValue: 'acme' })).toEqual({ ok: true, scopeType: 'team', scopeValue: 'acme' })
		expect(parseScope({})).toEqual({ ok: true, scopeType: null, scopeValue: null })
	})
})

describe('a key grant stored before `~` was reserved', () => {
	test('grants nothing at mint, and still keeps the key downscoped', async () => {
		const h = createHarness()
		const member = seedUser(h.sqlite, { sub: 'm', email: 'member@notes.test' })
		seedInlineGrant(h.sqlite, member, ['note.read'], null, PROD)
		const key = 'px_reserved-scope-key'
		await h.repositories.credentials.createCredential({
			tokenHash: await hashToken(key),
			principalId: member,
			app: PROD,
			issuedBy: member,
			grants: [{ action: 'note.read', scopeType: '~rel', scopeValue: 'assignee' }],
		})

		const minted = await mintFromKey(h.makeServices({ issuer: ISSUER }), ENV, { app: PROD, key, requestId: 'r' })
		if (!minted.result.ok) throw new Error(`mint failed: ${minted.result.reason}`)
		const { payload } = await jwtVerify(minted.result.token, createLocalJWKSet((await getSigner(ENV)).jwks()), { issuer: ISSUER, audience: PROD })
		expect(parseAccessClaims(payload)?.perms).toEqual([])
	})
})
