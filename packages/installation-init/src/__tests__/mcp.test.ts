import type { OAuthResourceDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { parseMcpAuthoring, platformIamOAuthConfig, refuseMcpClientsVariable } from '../mcp'
import type { PlatformProxyComposition, PlatformProxyManifestTemplate } from '../proxy-manifest'

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
	test('a set value is refused, naming its source and the ways out', () => {
		const refusal = () => refuseMcpClientsVariable('[]', 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON')
		expect(refusal).toThrow('FABRIKA_PLATFORM_MCP_CLIENTS_JSON is set, and this release no longer reads it')
		expect(refusal).toThrow('upgrade through release v0.9.0-dev.47 first')
		expect(refusal).toThrow('`fabrika control external-apps`')
		expect(refusal).toThrow('set FABRIKA_PLATFORM_MCP_AUTHORING=on')
		expect(() => refuseMcpClientsVariable('x', '--mcp-clients')).toThrow('--mcp-clients is set')
	})

	test('unset or blank is not set: a workflow passes an unset variable as an empty string', () => {
		refuseMcpClientsVariable(undefined, 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON')
		refuseMcpClientsVariable('', 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON')
		refuseMcpClientsVariable(' \n', 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON')
	})
})

describe('the MCP authoring switch', () => {
	test('reads on and off, is absent when unset, and refuses anything else naming its source', () => {
		expect(parseMcpAuthoring('on', 'FABRIKA_PLATFORM_MCP_AUTHORING')).toBe(true)
		expect(parseMcpAuthoring('off', 'FABRIKA_PLATFORM_MCP_AUTHORING')).toBe(false)
		expect(parseMcpAuthoring(undefined, 'FABRIKA_PLATFORM_MCP_AUTHORING')).toBeUndefined()
		for (const raw of ['true', 'ON', '1', 'yes']) {
			expect(() => parseMcpAuthoring(raw, '--mcp-authoring')).toThrow('--mcp-authoring must be on or off')
		}
	})
})

describe("IAM's OAuth configuration", () => {
	const HOSTS = ['iam.example.test', 'console.example.test', 'operations.example.test']

	test('with MCP authoring, it names the command-line resources and the RFC 8707 MCP resource with its scope ceiling', () => {
		expect(platformIamOAuthConfig(TEMPLATE, COMPOSITION)).toEqual({
			resources: [RPC_RESOURCE, {
				app: 'vozka',
				resource: 'https://console.example.test/mcp',
				defaultScopes: ['authoring'],
				scopeGrants: [{ scope: 'authoring', permissions: [{ action: 'deploy.read' }] }],
			}],
			hosts: HOSTS,
		})
	})

	test('without MCP authoring, it names only the command-line resources', () => {
		expect(platformIamOAuthConfig(TEMPLATE, { ...COMPOSITION, mcp: false })).toEqual({ resources: [RPC_RESOURCE], hosts: HOSTS })
	})

	test("names every host of the installation once, the list IAM checks a registered application's resource against", () => {
		const shared = { ...COMPOSITION, placement: { ...COMPOSITION.placement, operations: { hosts: ['console.example.test'] } } }
		expect(platformIamOAuthConfig(TEMPLATE, { ...shared, mcp: false }).hosts).toEqual(['iam.example.test', 'console.example.test'])
	})

	test('without an authorization server there is nothing to configure', () => {
		const { authorizationServer: _, ...plain } = COMPOSITION
		expect(() => platformIamOAuthConfig(TEMPLATE, { ...plain, mcp: false })).toThrow('no OAuth resource')
	})
})
