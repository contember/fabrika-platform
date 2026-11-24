import { describe, expect, test } from 'bun:test'
import { cloudflareMcpAuthoringOn, cloudflarePlatformHosts } from '../mcp-authoring'

const IDENTITY_ONLY = {
	provider: 'external',
	clientId: 'https://ops.example.org/oauth/client.json',
	redirectUris: ['https://ops.example.org/callback'],
	identity: { app: 'ops-tool', resource: 'https://ops.example.org' },
}

describe('MCP authoring on a Cloudflare installation', () => {
	test('is off without a client list, and with only identity-bound clients', () => {
		expect(cloudflareMcpAuthoringOn({})).toBe(false)
		expect(cloudflareMcpAuthoringOn({ FABRIKA_PLATFORM_MCP_CLIENTS_JSON: ' ' })).toBe(false)
		expect(cloudflareMcpAuthoringOn({ FABRIKA_PLATFORM_MCP_CLIENTS_JSON: JSON.stringify([IDENTITY_ONLY]) })).toBe(false)
	})

	test('parses the list as the platform stage does, so a list it refuses stops the deploy', () => {
		expect(() => cloudflareMcpAuthoringOn({ FABRIKA_PLATFORM_MCP_CLIENTS_JSON: 'not json' })).toThrow('FABRIKA_PLATFORM_MCP_CLIENTS_JSON')
		const onConsole = { ...IDENTITY_ONLY, identity: { app: 'ops-tool', resource: 'https://console.example.com/ops' } }
		expect(() =>
			cloudflareMcpAuthoringOn({ FABRIKA_CONTROL_DOMAIN: 'console.example.com', FABRIKA_PLATFORM_MCP_CLIENTS_JSON: JSON.stringify([onConsole]) })
		).toThrow("on a platform service's host")
	})

	test("names the console's, IAM's and Operations' hosts the stage was handed", () => {
		expect(cloudflarePlatformHosts({
			FABRIKA_CONTROL_DOMAIN: 'console.example.com',
			FABRIKA_IAM_ISSUER: 'https://iam.example.com',
			OPERATIONS_ARTIFACT_ORIGIN: 'https://operations.example.com',
		})).toEqual(['console.example.com', 'iam.example.com', 'operations.example.com'])
		expect(cloudflarePlatformHosts({ FABRIKA_CONTROL_DOMAIN: '', FABRIKA_IAM_ISSUER: 'not a url' })).toEqual([])
	})
})
