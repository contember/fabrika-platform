import { describe, expect, test } from 'bun:test'
import {
	OAUTH_CLIENT_PROVIDERS,
	type OAuthManagedClient,
	parseOAuthAuthorizationRequest,
	parseOAuthClientMetadata,
	parseOAuthManagedClient,
	parseOAuthResourceDto,
	resolveOAuthAuthorizationScopes,
} from '../oauth'

const EXTERNAL: OAuthManagedClient = {
	provider: 'external',
	clientId: 'https://ops.example.test/oauth/client.json',
	redirectUris: ['https://ops.example.test/oauth/callback'],
}

const RESOURCE = 'https://console.example.test/mcp'

describe('managed client kinds', () => {
	test.each(OAUTH_CLIENT_PROVIDERS.map((provider) => [provider]))('a %s client is accepted', (provider) => {
		expect(parseOAuthManagedClient({ ...EXTERNAL, provider })).toEqual({ ...EXTERNAL, provider })
	})

	test('an unknown kind is refused', () => {
		expect(parseOAuthManagedClient({ ...EXTERNAL, provider: 'other' })).toBeNull()
		expect(parseOAuthManagedClient({ clientId: EXTERNAL.clientId, redirectUris: EXTERNAL.redirectUris })).toBeNull()
	})

	test('an external client still needs an https CIMD client id and exact redirect URIs', () => {
		expect(parseOAuthManagedClient({ ...EXTERNAL, clientId: 'http://ops.example.test/oauth/client.json' })).toBeNull()
		expect(parseOAuthManagedClient({ ...EXTERNAL, redirectUris: [] })).toBeNull()
	})
})

describe("an external client's metadata document", () => {
	const document = {
		client_id: EXTERNAL.clientId,
		client_name: 'Operations tool',
		redirect_uris: EXTERNAL.redirectUris,
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
	}

	test('a public client with the code flow is accepted', () => {
		expect(parseOAuthClientMetadata(document, EXTERNAL)?.token_endpoint_auth_method).toBe('none')
	})

	test('an implicit response type is refused, and an implicit grant is never served', () => {
		expect(parseOAuthClientMetadata({ ...document, response_types: ['token'] }, EXTERNAL)).toBeNull()
		expect(parseOAuthClientMetadata({ ...document, grant_types: ['authorization_code', 'implicit'] }, EXTERNAL)?.grant_types).toEqual([
			'authorization_code',
		])
	})

	test('a document without the authorization code grant is refused', () => {
		expect(parseOAuthClientMetadata({ ...document, grant_types: ['implicit'] }, EXTERNAL)).toBeNull()
	})

	test('the document cannot add a redirect URI beyond the registration', () => {
		expect(parseOAuthClientMetadata({ ...document, redirect_uris: [...EXTERNAL.redirectUris, 'https://evil.example.test/cb'] }, EXTERNAL)).toBeNull()
	})

	test('a client secret is refused', () => {
		expect(parseOAuthClientMetadata({ ...document, client_secret: 'secret' }, EXTERNAL)).toBeNull()
	})
})

// Nothing below reads the client's kind: an external client is held to the same request rules as every other.
describe('an authorization request, whatever the client kind', () => {
	const request = {
		response_type: 'code',
		client_id: EXTERNAL.clientId,
		redirect_uri: EXTERNAL.redirectUris[0],
		resource: RESOURCE,
		scope: 'read',
		code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		code_challenge_method: 'S256',
	}

	test('needs the code flow, S256 PKCE and an RFC 8707 resource', () => {
		expect(parseOAuthAuthorizationRequest(request)).not.toBeNull()
		expect(parseOAuthAuthorizationRequest({ ...request, response_type: 'token' })).toBeNull()
		expect(parseOAuthAuthorizationRequest({ ...request, code_challenge_method: 'plain' })).toBeNull()
		expect(parseOAuthAuthorizationRequest({ ...request, code_challenge: undefined })).toBeNull()
		expect(parseOAuthAuthorizationRequest({ ...request, resource: undefined })).toBeNull()
	})

	test('a scope outside the resource ceiling resolves to nothing', () => {
		const resource = parseOAuthResourceDto({
			app: 'control',
			resource: RESOURCE,
			scopeGrants: [{ scope: 'read', permissions: [{ action: 'deploy.read' }] }],
		})
		expect(resource).not.toBeNull()
		if (resource === null) return
		expect(resolveOAuthAuthorizationScopes('read', resource)).toEqual(['read'])
		expect(resolveOAuthAuthorizationScopes('read write', resource)).toBeNull()
	})
})
