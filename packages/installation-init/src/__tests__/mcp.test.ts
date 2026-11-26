import type { OAuthResourceDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { mcpAuthoringOn, type McpClient, parseMcpAuthoring, parseMcpClientsJson, platformIamOAuthConfig, resolveMcpAuthoring } from '../mcp'
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

	test('clients of one external application must name one resource and one list of roles, as the registry holds', () => {
		const roles = [{ key: 'viewer', name: 'Viewer' }]
		const web = { ...OPS_TOOL, identity: { app: 'ops-tool', resource: 'https://ops.example.test', roles } }
		const native = { ...web, clientId: 'https://ops.example.test/oauth/native.json' }
		expect(parseMcpClientsJson(JSON.stringify([web, native]))).toEqual([web, native])
		const unroled = { ...native, identity: { app: 'ops-tool', resource: 'https://ops.example.test' } }
		expect(() => parseMcpClientsJson(JSON.stringify([web, unroled]))).toThrow('names another resource or other roles')
		const elsewhere = { ...native, identity: { ...web.identity, resource: 'https://ops.example.test/native' } }
		expect(() => parseMcpClientsJson(JSON.stringify([web, elsewhere]))).toThrow('names another resource or other roles')
	})

	test('two external applications must not name one identity resource, as the registry refuses', () => {
		const other = {
			...OPS_TOOL,
			clientId: 'https://other.example.test/oauth/client.json',
			identity: { app: 'other-tool', resource: OPS_TOOL.identity?.resource ?? '' },
		}
		expect(() => parseMcpClientsJson(JSON.stringify([OPS_TOOL, other]))).toThrow(
			'`ops-tool` and `other-tool` name one identity resource, https://ops.example.test',
		)
		const apart = { ...other, identity: { app: 'other-tool', resource: 'https://other.example.test' } }
		expect(parseMcpClientsJson(JSON.stringify([OPS_TOOL, apart]))).toEqual([OPS_TOOL, apart])
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

describe('the MCP authoring switch', () => {
	const NAMES = { setting: 'FABRIKA_PLATFORM_MCP_AUTHORING', clients: 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON' }

	test('reads on and off, is absent when unset, and refuses anything else naming its source', () => {
		expect(parseMcpAuthoring('on', NAMES.setting)).toBe(true)
		expect(parseMcpAuthoring('off', NAMES.setting)).toBe(false)
		expect(parseMcpAuthoring(undefined, NAMES.setting)).toBeUndefined()
		for (const raw of ['true', 'ON', '1', 'yes']) {
			expect(() => parseMcpAuthoring(raw, '--mcp-authoring')).toThrow('--mcp-authoring must be on or off')
		}
	})

	test('set, it decides whatever the client list holds', () => {
		expect(resolveMcpAuthoring(false, [CLAUDE], NAMES)).toEqual({ on: false })
		expect(resolveMcpAuthoring(true, undefined, NAMES)).toEqual({ on: true })
		expect(resolveMcpAuthoring(true, [OPS_TOOL], NAMES)).toEqual({ on: true })
	})

	test('unset, an authoring entry in the list still turns it on, with a warning that names the switch', () => {
		const inferred = resolveMcpAuthoring(undefined, [OPS_TOOL, CLAUDE], NAMES)
		expect(inferred.on).toBe(true)
		expect(inferred.warning).toContain('set FABRIKA_PLATFORM_MCP_AUTHORING=on')
		expect(inferred.warning).toContain('FABRIKA_PLATFORM_MCP_CLIENTS_JSON')
		// Off stays off without the switch, so nothing needs saying.
		expect(resolveMcpAuthoring(undefined, [OPS_TOOL], NAMES)).toEqual({ on: false })
		expect(resolveMcpAuthoring(undefined, undefined, NAMES)).toEqual({ on: false })
	})
})

describe("IAM's OAuth configuration", () => {
	const HOSTS = ['iam.example.test', 'console.example.test', 'operations.example.test']

	test('an external client gets the RFC 8707 resource with its scope ceiling, like any other client', () => {
		expect(platformIamOAuthConfig(TEMPLATE, COMPOSITION, [EXTERNAL])).toEqual({
			clients: [EXTERNAL],
			resources: [RPC_RESOURCE, {
				app: 'vozka',
				resource: 'https://console.example.test/mcp',
				defaultScopes: ['authoring'],
				scopeGrants: [{ scope: 'authoring', permissions: [{ action: 'deploy.read' }] }],
			}],
			hosts: HOSTS,
		})
	})

	test('without MCP authoring, it names no client and only the command-line resources', () => {
		expect(platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false }, [])).toEqual({ clients: [], resources: [RPC_RESOURCE], hosts: HOSTS })
	})

	test('an identity-only client is listed with its binding, and adds no resource', () => {
		expect(platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false }, [OPS_TOOL])).toEqual({
			clients: [OPS_TOOL],
			resources: [RPC_RESOURCE],
			hosts: HOSTS,
		})
	})

	test("names every host of the installation once, the list IAM checks a registered application's resource against", () => {
		const shared = { ...COMPOSITION, placement: { ...COMPOSITION.placement, operations: { hosts: ['console.example.test'] } } }
		expect(platformIamOAuthConfig(TEMPLATE, { ...shared, mcp: false }, []).hosts).toEqual(['iam.example.test', 'console.example.test'])
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
