import { describe, expect, test } from 'bun:test'
import { type McpClient, parseMcpClientsJson, platformIamOAuthConfig } from '../mcp'
import type { PlatformProxyComposition, PlatformProxyManifestTemplate } from '../proxy-manifest'

const CLAUDE: McpClient = {
	provider: 'claude',
	clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
	redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
}
const CHATGPT: McpClient = {
	provider: 'chatgpt',
	clientId: 'https://chatgpt.com/oauth/client.json',
	redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
}
const EXTERNAL: McpClient = {
	provider: 'external',
	clientId: 'https://ops.example.test/oauth/client.json',
	redirectUris: ['https://ops.example.test/oauth/callback'],
	metadataUrl: 'https://ops.example.test/oauth/client.json',
}

const TABLE = { endpoints: [], reservedPrefixes: [] }
const TEMPLATE: PlatformProxyManifestTemplate = {
	apps: [
		{ id: 'propustka', service: 'iam', port: 8080, upstream: 'iam', table: TABLE },
		{
			id: 'vozka',
			service: 'control',
			port: 8080,
			upstream: 'control',
			table: TABLE,
			oauth: {
				resources: [{ path: '/api/rpc', scopes: ['deploy'], scopeGrants: [{ scope: 'deploy', parameter: 'app', actions: ['deploy.trigger'] }] }],
				table: TABLE,
				mcp: {
					resource: { path: '/mcp', scopes: ['authoring'], defaultScopes: ['authoring'], scopeGrants: [{ scope: 'authoring', actions: ['deploy.read'] }] },
					table: TABLE,
				},
			},
		},
		{ id: 'operations', service: 'operations', port: 8080, upstream: 'operations', table: TABLE },
	],
}
const COMPOSITION: PlatformProxyComposition = {
	scheme: 'https',
	placement: {
		iam: { hosts: ['iam.example.test'] },
		control: { hosts: ['console.example.test'] },
		operations: { hosts: ['operations.example.test'] },
	},
	authorizationServer: 'https://iam.example.test',
	mcp: true,
}
const RPC_RESOURCE = {
	app: 'vozka',
	resource: 'https://console.example.test/api/rpc',
	scopeGrants: [{ scope: 'deploy', parameter: 'app', permissions: [{ action: 'deploy.trigger' }] }],
	client: 'cli',
}

describe('the MCP client list', () => {
	test('accepts an external client beside claude and chatgpt', () => {
		expect(parseMcpClientsJson(JSON.stringify([CLAUDE, CHATGPT, EXTERNAL]))).toEqual([CLAUDE, CHATGPT, EXTERNAL])
	})

	test('refuses an unknown kind, naming every accepted one', () => {
		expect(() => parseMcpClientsJson(JSON.stringify([{ ...EXTERNAL, provider: 'other' }]))).toThrow(
			"MCP client 0 must be { provider: 'claude' | 'chatgpt' | 'external', clientId",
		)
	})

	test('refuses an external client with a non-https metadata URL', () => {
		expect(() => parseMcpClientsJson(JSON.stringify([{ ...EXTERNAL, metadataUrl: 'http://ops.example.test/c.json' }]))).toThrow('metadataUrl')
	})
})

describe("IAM's OAuth configuration", () => {
	test('an external client gets the RFC 8707 resource with its scope ceiling, like any other client', () => {
		expect(platformIamOAuthConfig(TEMPLATE, COMPOSITION, [EXTERNAL])).toEqual({
			clients: [EXTERNAL],
			resources: [RPC_RESOURCE, {
				app: 'vozka',
				resource: 'https://console.example.test/mcp',
				defaultScopes: ['authoring'],
				scopeGrants: [{ scope: 'authoring', permissions: [{ action: 'deploy.read' }] }],
			}],
		})
	})

	test('without MCP authoring, it names no client and only the command-line resources', () => {
		expect(platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false }, [])).toEqual({ clients: [], resources: [RPC_RESOURCE] })
	})

	test('without an authorization server there is nothing to configure', () => {
		const { authorizationServer: _, ...plain } = COMPOSITION
		expect(() => platformIamOAuthConfig(TEMPLATE, { ...plain, mcp: false }, [])).toThrow('no OAuth resource')
	})
})
