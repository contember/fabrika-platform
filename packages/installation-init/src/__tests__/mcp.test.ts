import type { OAuthResourceDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { identityAppSchemas, mcpAuthoringOn, type McpClient, parseMcpClientsJson, platformIamOAuthConfig } from '../mcp'
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
const OPS_TOOL: McpClient = {
	provider: 'external',
	clientId: 'https://ops.example.test/oauth/client.json',
	redirectUris: ['https://ops.example.test/oauth/callback'],
	identity: { app: 'ops-tool', resource: 'https://ops.example.test' },
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
const RPC_RESOURCE: OAuthResourceDto = {
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

	test('accepts an identity-only external client, and refuses the binding on another kind or malformed', () => {
		expect(parseMcpClientsJson(JSON.stringify([OPS_TOOL]))).toEqual([OPS_TOOL])
		expect(() => parseMcpClientsJson(JSON.stringify([{ ...OPS_TOOL, provider: 'claude' }]))).toThrow('only on an external client')
		expect(() => parseMcpClientsJson(JSON.stringify([{ ...OPS_TOOL, identity: { app: 'ops-tool' } }]))).toThrow('identity is')
		expect(() => parseMcpClientsJson(JSON.stringify([{ ...OPS_TOOL, identity: { app: 'ops@prod', resource: 'https://ops.example.test' } }]))).toThrow()
	})

	test("an external application's roles become its IAM vocabulary, once per app, each granting no action", () => {
		const roles = [{ key: 'admin-ops', name: 'Administrator' }, { key: 'viewer', name: 'Viewer' }]
		const web = { ...OPS_TOOL, identity: { ...OPS_TOOL.identity, app: 'ops-tool', resource: 'https://ops.example.test', roles } }
		const native = { ...web, clientId: 'https://ops.example.test/oauth/native.json' }
		expect(parseMcpClientsJson(JSON.stringify([web, native]))).toEqual([web, native])
		// An identity-only client without roles adds no vocabulary.
		const other = {
			...OPS_TOOL,
			clientId: 'https://other.example.test/oauth/client.json',
			identity: { app: 'other', resource: 'https://other.example.test' },
		}
		expect(identityAppSchemas([web, native, other]))
			.toEqual([{
				app: 'ops-tool',
				schema: {
					scopes: [],
					actions: [],
					roles: { 'admin-ops': { name: 'Administrator', permissions: [] }, viewer: { name: 'Viewer', permissions: [] } },
				},
			}])
	})

	test('two clients of one external application must declare the same roles', () => {
		const roles = [{ key: 'viewer', name: 'Viewer' }]
		const web = { ...OPS_TOOL, identity: { app: 'ops-tool', resource: 'https://ops.example.test', roles } }
		const native = { ...OPS_TOOL, clientId: 'https://ops.example.test/oauth/native.json' }
		expect(() => parseMcpClientsJson(JSON.stringify([web, native]))).toThrow('declares other roles')
	})

	test('only a client that is not identity-only turns MCP authoring on', () => {
		expect(mcpAuthoringOn(undefined)).toBe(false)
		expect(mcpAuthoringOn([OPS_TOOL])).toBe(false)
		expect(mcpAuthoringOn([OPS_TOOL, EXTERNAL])).toBe(true)
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

	test('an identity-only client is listed with its binding, and adds no resource', () => {
		expect(platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false }, [OPS_TOOL])).toEqual({ clients: [OPS_TOOL], resources: [RPC_RESOURCE] })
	})

	test("an identity resource on a platform host, or under a platform service's app id, is refused", () => {
		const onConsole = { ...OPS_TOOL, identity: { app: 'ops-tool', resource: 'https://console.example.test/ops' } }
		expect(() => platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false }, [onConsole])).toThrow("platform service's app id or host")
		for (const app of ['vozka', 'propustka', 'operations']) {
			const asPlatform = { ...OPS_TOOL, identity: { app, resource: 'https://ops.example.test', roles: [{ key: 'viewer', name: 'Viewer' }] } }
			expect(() => platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false }, [asPlatform])).toThrow("platform service's app id or host")
		}
	})

	test('without an authorization server there is nothing to configure', () => {
		const { authorizationServer: _, ...plain } = COMPOSITION
		expect(() => platformIamOAuthConfig(TEMPLATE, { ...plain, mcp: false }, [])).toThrow('no OAuth resource')
	})
})
