import { describe, expect, test } from 'bun:test'
import { buildAccessClaims, buildResourceAccessClaims, matchesTokenAudience, parseAccessClaims, type ResourceAccessTokenParams } from '../token'

const APP = 'vozka'
const RESOURCE = 'https://vozka.test/mcp'

const PARAMS: ResourceAccessTokenParams = {
	iss: 'https://iam.test',
	app: APP,
	resource: RESOURCE,
	subject: 'user-1',
	label: 'a@b.cz',
	permissions: [{ action: 'workspace.write', scope: null, source: 'grant' }],
	issuedAt: 1_000,
	expiresAt: 1_300,
	clientId: 'https://client.test/metadata.json',
	scopes: ['authoring', 'read'],
	grantId: 'grant-1',
	tokenId: 'token-1',
}

function parsedResourceClaims() {
	const claims = parseAccessClaims(buildResourceAccessClaims(PARAMS))
	if (claims === null) throw new Error('resource claims did not parse')
	return claims
}

function parsedAppClaims() {
	const claims = parseAccessClaims(
		buildAccessClaims({ iss: 'https://iam.test', app: APP, subject: 'user-1', type: 'user', label: null, permissions: [], issuedAt: 1, expiresAt: 2 }),
	)
	if (claims === null) throw new Error('app claims did not parse')
	return claims
}

describe('buildResourceAccessClaims', () => {
	test('round-trips through parseAccessClaims as a user token for the resource', () => {
		expect(parsedResourceClaims()).toEqual({
			iss: 'https://iam.test',
			aud: RESOURCE,
			sub: 'user-1',
			iat: 1_000,
			exp: 1_300,
			perms: PARAMS.permissions,
			ptype: 'user',
			label: 'a@b.cz',
			oauth: { app: APP, clientId: PARAMS.clientId, scopes: ['authoring', 'read'], grantId: 'grant-1', tokenId: 'token-1' },
		})
	})

	test('refuses parameters that cannot form valid OAuth claims', () => {
		expect(() => buildResourceAccessClaims({ ...PARAMS, resource: 'not-a-uri' })).toThrow()
		expect(() => buildResourceAccessClaims({ ...PARAMS, clientId: 'http://client.test/metadata.json' })).toThrow()
		expect(() => buildResourceAccessClaims({ ...PARAMS, scopes: [] })).toThrow()
		expect(() => buildResourceAccessClaims({ ...PARAMS, grantId: '' })).toThrow()
	})
})

describe('parseAccessClaims — OAuth claims', () => {
	test('partial OAuth claims are refused, never read as a native token', () => {
		const payload = buildResourceAccessClaims(PARAMS)
		for (const claim of ['app', 'client_id', 'scope', 'grant', 'jti']) {
			const { [claim]: _removed, ...partial } = payload
			expect(parseAccessClaims(partial)).toBeNull()
		}
	})

	test('OAuth claims on a non-user or non-resource token are refused', () => {
		const payload = buildResourceAccessClaims(PARAMS)
		expect(parseAccessClaims({ ...payload, ptype: 'service' })).toBeNull()
		expect(parseAccessClaims({ ...payload, ptype: undefined })).toBeNull()
		expect(parseAccessClaims({ ...payload, aud: APP })).toBeNull()
	})
})

describe('matchesTokenAudience', () => {
	test('a resource token matches only its own resource and app', () => {
		const claims = parsedResourceClaims()
		expect(matchesTokenAudience(claims, { kind: 'resource', app: APP, resource: RESOURCE })).toBe(true)
		expect(matchesTokenAudience(claims, { kind: 'resource', app: 'other', resource: RESOURCE })).toBe(false)
		expect(matchesTokenAudience(claims, { kind: 'resource', app: APP, resource: `${RESOURCE}/other` })).toBe(false)
	})

	test('a resource token never matches an app profile, and an app token never matches a resource profile', () => {
		expect(matchesTokenAudience(parsedResourceClaims(), { kind: 'app', app: APP })).toBe(false)
		expect(matchesTokenAudience(parsedResourceClaims(), { kind: 'app', app: RESOURCE })).toBe(false)
		expect(matchesTokenAudience(parsedAppClaims(), { kind: 'app', app: APP })).toBe(true)
		expect(matchesTokenAudience(parsedAppClaims(), { kind: 'resource', app: APP, resource: APP })).toBe(false)
	})
})
